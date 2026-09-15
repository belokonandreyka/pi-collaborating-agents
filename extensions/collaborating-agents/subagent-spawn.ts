import { resolveProfileAgentDir } from "./paths.js";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getDefaultSubagentType } from "./subagent-types.js";
import { resolveDirs } from "./paths.js";
import type { SubagentLaunchMode, SubagentTypeConfig } from "./types.js";
import {
  herdrCallerPaneFromEnv,
  herdrClosePane,
  herdrListPanes,
  herdrReadPane,
  herdrSendLine,
  herdrSplitPane,
} from "./herdr.js";

export interface SpawnAgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "bundled" | "user" | "project";
  filePath: string;
}

export interface SpawnTask {
  agent: string;
  task: string;
  cwd?: string;
}

export interface SpawnResult {
  agent: string;
  name: string;
  task: string;
  exitCode: number;
  output: string;
  error?: string;
  warnings?: string[];
  sessionId?: string;
  sessionFile?: string;
  sessionFileUnavailableReason?: string;
  launchMode: SubagentLaunchMode;
  workingDirectory: string;
  launchArgs: string[];
  launchCommand: string;
  launchPrompt: string;
  launchSystemPromptSource?: string;
  launchSystemPromptLength?: number;
  workspaceRef?: string;
  paneRef?: string;
  surfaceRef?: string;
  launchEnv: {
    PI_AGENT_NAME: string;
    PI_COLLAB_SUBAGENT_DEPTH: string;
    PI_CODING_AGENT_DIR?: string;
    /** The parent's collaboration bus, pinned so a child in another profile still shares it. */
    COLLABORATING_AGENTS_DIR: string;
  };
  launchDelayMs?: number;
  resolvedModel?: string;
  resolvedTools?: string[];
  coordinator?: string;
  paneClosed?: boolean;
  paneCloseError?: string;
  /**
   * Set when the child ended its turn on a question for its coordinator instead of a
   * report. The session and its pane are still alive; answer with `replyToSubagent`.
   */
  awaitingReply?: string;
}

export const PROCESS_MODE_SESSION_FILE_UNAVAILABLE_REASON =
  "Process-mode session file unavailable until child registration or fallback discovery provides one.";

export interface SpawnSessionMetadata {
  name: string;
  sessionId?: string;
  sessionFile?: string;
}

type SpawnSessionMetadataCallback = (metadata: SpawnSessionMetadata) => void | Promise<void>;

/** Live activity of a running child, derived from its session file. */
export interface SubagentProgress {
  toolCount: number;
  lastTool?: string;
}

export type SubagentProgressCallback = (progress: SubagentProgress) => void;

export const DEFAULT_SUBAGENT_TOOLS = ["read", "write", "edit", "bash", "agent_message"];

const LOCAL_COLLABORATING_AGENTS_EXTENSION = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");
const HOME_COLLABORATING_AGENTS_EXTENSION = path.join(os.homedir(), ".pi", "agent", "extensions", "collaborating-agents", "index.ts");
const PANE_IDLE_GRACE_MS = 1200;
// An assistant error can be a transient provider failure the pane recovers from,
// so an error must not settle the run as fast as a clean answer does. But waiting
// for the exit marker alone is unbounded: a child that dies before its wrapper
// writes the marker leaves the parent parked on the full inactivity budget with
// no signal at all. A recovering pane keeps writing records, which resets the
// activity clock, so total silence for this long after an error means it is not
// coming back.
// Pi retries transient provider errors on its own (3 attempts, 2/4/8 s backoff) and
// the retried request can itself run to the SDK timeout, so an error message in the
// transcript is only final once the child has stayed silent well past that.
const PANE_ERROR_SETTLE_MS = 120_000;
const PANE_RESULT_TIMEOUT_MS = 600_000;
const PANE_MAX_IDLE_TIMEOUT_MULTIPLIER = 6;
const PANE_MAX_IDLE_TIMEOUT_BUFFER_MS = 60_000;

type PaneLayoutRole = "orchestrator" | "subagent";
type PaneSplitDirection = "right" | "down";

interface FileChangeToken {
  mtimeMs: number;
  size: number;
}

interface PaneLayoutLeafNode {
  kind: "leaf";
  id: string;
  paneRef: string;
  surfaceRef: string;
  role: PaneLayoutRole;
  order: number;
}

interface PaneLayoutBranchNode {
  kind: "branch";
  id: string;
  left: PaneLayoutNode;
  right: PaneLayoutNode;
}

type PaneLayoutNode = PaneLayoutLeafNode | PaneLayoutBranchNode;

interface PaneLayoutLeafCandidate extends PaneLayoutLeafNode {
  depth: number;
}

interface PaneWorkspaceLayoutState {
  workspaceRef: string;
  orchestratorPaneRef: string;
  orchestratorSurfaceRef: string;
  root: PaneLayoutNode;
  nextNodeId: number;
  nextOrder: number;
}

// Tracks the orchestrator + live subagent panes per workspace so we can keep
// splitting the largest managed pane instead of repeatedly shrinking the
// orchestrator pane.
const paneWorkspaceLayouts = new Map<string, PaneWorkspaceLayoutState>();
let paneLayoutLock: Promise<void> = Promise.resolve();

function createPaneWorkspaceLayoutState(args: {
  workspaceRef: string;
  paneRef: string;
  surfaceRef: string;
}): PaneWorkspaceLayoutState {
  return {
    workspaceRef: args.workspaceRef,
    orchestratorPaneRef: args.paneRef,
    orchestratorSurfaceRef: args.surfaceRef,
    root: {
      kind: "leaf",
      id: "n0",
      paneRef: args.paneRef,
      surfaceRef: args.surfaceRef,
      role: "orchestrator",
      order: 0,
    },
    nextNodeId: 1,
    nextOrder: 1,
  };
}

function nextPaneLayoutNodeId(state: PaneWorkspaceLayoutState): string {
  const id = `n${state.nextNodeId}`;
  state.nextNodeId += 1;
  return id;
}

function collectPaneLayoutLeaves(node: PaneLayoutNode, depth = 0, leaves: PaneLayoutLeafCandidate[] = []): PaneLayoutLeafCandidate[] {
  if (node.kind === "leaf") {
    leaves.push({ ...node, depth });
    return leaves;
  }

  collectPaneLayoutLeaves(node.left, depth + 1, leaves);
  collectPaneLayoutLeaves(node.right, depth + 1, leaves);
  return leaves;
}

function findPaneLayoutLeaf(node: PaneLayoutNode, predicate: (leaf: PaneLayoutLeafNode) => boolean): PaneLayoutLeafNode | null {
  if (node.kind === "leaf") {
    return predicate(node) ? node : null;
  }

  return findPaneLayoutLeaf(node.left, predicate) ?? findPaneLayoutLeaf(node.right, predicate);
}

function replacePaneLayoutLeaf(node: PaneLayoutNode, targetLeafId: string, replacement: PaneLayoutNode): PaneLayoutNode {
  if (node.kind === "leaf") {
    return node.id === targetLeafId ? replacement : node;
  }

  return {
    ...node,
    left: replacePaneLayoutLeaf(node.left, targetLeafId, replacement),
    right: replacePaneLayoutLeaf(node.right, targetLeafId, replacement),
  };
}

function removePaneLayoutLeaf(node: PaneLayoutNode, predicate: (leaf: PaneLayoutLeafNode) => boolean): PaneLayoutNode | null {
  if (node.kind === "leaf") {
    return predicate(node) ? null : node;
  }

  const left = removePaneLayoutLeaf(node.left, predicate);
  const right = removePaneLayoutLeaf(node.right, predicate);

  if (!left && !right) return null;
  if (!left) return right;
  if (!right) return left;

  return {
    ...node,
    left,
    right,
  };
}

function getOrCreatePaneWorkspaceLayout(args: {
  workspaceRef: string;
  paneRef: string;
  surfaceRef: string;
}): PaneWorkspaceLayoutState {
  const existing = paneWorkspaceLayouts.get(args.workspaceRef);
  if (!existing) {
    const created = createPaneWorkspaceLayoutState(args);
    paneWorkspaceLayouts.set(args.workspaceRef, created);
    return created;
  }

  const orchestratorLeaf = findPaneLayoutLeaf(existing.root, (leaf) => leaf.role === "orchestrator");
  if (!orchestratorLeaf || orchestratorLeaf.surfaceRef !== args.surfaceRef) {
    const reset = createPaneWorkspaceLayoutState(args);
    paneWorkspaceLayouts.set(args.workspaceRef, reset);
    return reset;
  }

  orchestratorLeaf.surfaceRef = args.surfaceRef;
  existing.orchestratorSurfaceRef = args.surfaceRef;
  return existing;
}

function choosePaneSplitLeaf(
  state: PaneWorkspaceLayoutState,
  preserveOrchestratorPane: boolean,
): PaneLayoutLeafCandidate {
  // The shallowest leaf approximates the largest visible pane in the current
  // split tree. Preserved layouts balance only within the subagent subtree once
  // it exists; legacy layouts merely prefer subagents on depth ties.
  const leaves = collectPaneLayoutLeaves(state.root);
  const subagentLeaves = preserveOrchestratorPane ? leaves.filter((leaf) => leaf.role === "subagent") : [];
  const candidates = subagentLeaves.length > 0 ? subagentLeaves : leaves;
  const [selected] = candidates.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.role !== b.role) return a.role === "subagent" ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.id.localeCompare(b.id);
  });

  return selected;
}

function choosePaneSplitDirection(splitLeaf: PaneLayoutLeafCandidate): PaneSplitDirection {
  // Alternate horizontal and vertical splits by tree depth so the managed pane
  // layout grows toward a grid instead of endlessly slicing columns.
  return splitLeaf.depth % 2 === 0 ? "right" : "down";
}

function applyPaneSplitToLayout(
  state: PaneWorkspaceLayoutState,
  splitLeaf: PaneLayoutLeafCandidate,
  createdPaneRef: string,
  createdSurfaceRef: string,
): void {
  const newPaneLeaf: PaneLayoutLeafNode = {
    kind: "leaf",
    id: nextPaneLayoutNodeId(state),
    paneRef: createdPaneRef,
    surfaceRef: createdSurfaceRef,
    role: "subagent",
    order: state.nextOrder,
  };
  state.nextOrder += 1;

  state.root = replacePaneLayoutLeaf(state.root, splitLeaf.id, {
    kind: "branch",
    id: nextPaneLayoutNodeId(state),
    left: {
      kind: "leaf",
      id: splitLeaf.id,
      paneRef: splitLeaf.paneRef,
      surfaceRef: splitLeaf.surfaceRef,
      role: splitLeaf.role,
      order: splitLeaf.order,
    },
    right: newPaneLeaf,
  });
}

function removePaneFromLayout(workspaceRef: string, args: { paneRef?: string; surfaceRef?: string }): void {
  const state = paneWorkspaceLayouts.get(workspaceRef);
  if (!state) return;

  const nextRoot = removePaneLayoutLeaf(state.root, (leaf) => {
    if (leaf.role === "orchestrator") return false;
    if (args.surfaceRef && leaf.surfaceRef === args.surfaceRef) return true;
    if (args.paneRef && leaf.paneRef === args.paneRef) return true;
    return false;
  });

  if (!nextRoot) {
    paneWorkspaceLayouts.delete(workspaceRef);
    return;
  }

  state.root = nextRoot;
}

async function withPaneLayoutLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = paneLayoutLock;
  let release!: () => void;
  paneLayoutLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

export function resetPaneLayoutStateForTests(): void {
  paneWorkspaceLayouts.clear();
  paneLayoutLock = Promise.resolve();
}

export function createDefaultSpawnAgentDefinition(name = "subagent"): SpawnAgentDefinition {
  const defaultType = getDefaultSubagentType();

  return {
    name,
    description: defaultType.description,
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    systemPrompt: defaultType.prompt,
    source: defaultType.source,
    filePath: defaultType.filePath,
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---")) {
    return { frontmatter, body: normalized.trim() };
  }

  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized.trim() };
  }

  const block = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  for (const line of block.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[m[1]] = value;
  }

  return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): SpawnAgentDefinition[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: SpawnAgentDefinition[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (entry.name.endsWith(".chain.md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: tools && tools.length > 0 ? tools : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;

  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;

  return os.homedir();
}

export function discoverSpawnAgents(cwd: string): SpawnAgentDefinition[] {
  const profileDir = resolveProfileAgentDir();
  const legacyUserDir = path.join(profileDir, "agents");
  const preferredUserDir = path.join(path.dirname(profileDir), "agents");
  const projectDir = findNearestProjectAgentsDir(cwd);

  const userAgents = [
    ...loadAgentsFromDir(legacyUserDir, "user"),
    ...loadAgentsFromDir(preferredUserDir, "user"),
  ];
  const projectAgents = projectDir ? loadAgentsFromDir(projectDir, "project") : [];

  const map = new Map<string, SpawnAgentDefinition>();
  for (const agent of userAgents) map.set(agent.name, agent);
  for (const agent of projectAgents) map.set(agent.name, agent);

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeAgentKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export interface ResolveSpawnAgentResult {
  definition?: SpawnAgentDefinition;
  suggestions: string[];
  ambiguous: boolean;
}

export function resolveSpawnAgentDefinition(
  requestedName: string,
  available: SpawnAgentDefinition[],
): ResolveSpawnAgentResult {
  const requested = normalizeAgentKey(requestedName);
  const names = available.map((a) => a.name);

  if (!requested) {
    return { suggestions: names.slice(0, 8), ambiguous: false };
  }

  const exact = available.find((a) => a.name === requestedName);
  if (exact) {
    return { definition: exact, suggestions: [], ambiguous: false };
  }

  const normalizedExact = available.find((a) => normalizeAgentKey(a.name) === requested);
  if (normalizedExact) {
    return { definition: normalizedExact, suggestions: [normalizedExact.name], ambiguous: false };
  }

  const suffixMatches = available.filter((a) => normalizeAgentKey(a.name).endsWith(`-${requested}`));
  if (suffixMatches.length === 1) {
    return { definition: suffixMatches[0], suggestions: [suffixMatches[0].name], ambiguous: false };
  }

  const prefixMatches = available.filter((a) => normalizeAgentKey(a.name).startsWith(`${requested}-`));
  if (prefixMatches.length === 1) {
    return { definition: prefixMatches[0], suggestions: [prefixMatches[0].name], ambiguous: false };
  }

  const containsMatches = available.filter((a) => normalizeAgentKey(a.name).includes(requested));

  const suggestions = Array.from(
    new Set([...suffixMatches, ...prefixMatches, ...containsMatches].map((a) => a.name)),
  ).slice(0, 8);

  if (suffixMatches.length > 1 || prefixMatches.length > 1) {
    return { suggestions, ambiguous: true };
  }

  return { suggestions, ambiguous: false };
}

const CALLSIGN_FIRST_WORDS = [
  "amber",
  "autumn",
  "bright",
  "calm",
  "clear",
  "dawn",
  "deep",
  "gentle",
  "golden",
  "grand",
  "green",
  "lively",
  "mellow",
  "mighty",
  "quiet",
  "rising",
  "silver",
  "steady",
  "sunny",
  "swift",
  "warm",
  "young",
] as const;

const CALLSIGN_SECOND_WORDS = [
  "Anchor",
  "Breeze",
  "Brook",
  "Cloud",
  "Field",
  "Forest",
  "Garden",
  "Harbor",
  "Hill",
  "Lake",
  "Maple",
  "Meadow",
  "Moon",
  "Ocean",
  "Pine",
  "River",
  "Sparrow",
  "Stone",
  "Sun",
  "Thunder",
  "Valley",
  "Wave",
  "Willow",
] as const;

const usedCallsignsByRun = new Map<string, Set<string>>();

function toTitleCase(word: string): string {
  return word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function generateCallsignCandidate(runId: string, index: number, nonce: number): string {
  const hash = hashString(`${runId}:${index}:${nonce}`);
  const first = CALLSIGN_FIRST_WORDS[hash % CALLSIGN_FIRST_WORDS.length] ?? "bright";
  const second =
    CALLSIGN_SECOND_WORDS[(Math.floor(hash / CALLSIGN_FIRST_WORDS.length) + nonce) % CALLSIGN_SECOND_WORDS.length] ??
    "River";
  return `${toTitleCase(first)}${second}`;
}

function reserveReadableCallsign(runId: string, index: number): string {
  let used = usedCallsignsByRun.get(runId);
  if (!used) {
    used = new Set<string>();
    usedCallsignsByRun.set(runId, used);
    if (usedCallsignsByRun.size > 256) {
      const firstKey = usedCallsignsByRun.keys().next().value;
      if (typeof firstKey === "string") usedCallsignsByRun.delete(firstKey);
    }
  }

  for (let nonce = 0; nonce < 128; nonce++) {
    const callsign = generateCallsignCandidate(runId, index, nonce);
    if (!used.has(callsign)) {
      used.add(callsign);
      return callsign;
    }
  }

  const fallback = generateCallsignCandidate(runId, index, 0);
  used.add(fallback);
  return fallback;
}

function sanitizeAgentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || `agent-${Date.now()}`;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts = content
    .filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null && "type" in c)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string);
  return parts.join("\n").trim();
}

function extractToolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is { type: string; name?: string } => typeof c === "object" && c !== null && "type" in c)
    .filter((c) => c.type === "toolCall" && typeof c.name === "string")
    .map((c) => c.name as string);
}

// A child that asks its parent a question and then falls silent looks exactly like
// a child that finished: both end a turn and stop touching the session file. The
// only thing that tells them apart is the call itself, so pull the question text
// out of an `agent_message` send addressed at the parent.
function extractParentQuestion(content: unknown, parentAgentName?: string): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "toolCall" || record.name !== "agent_message") continue;

    let args = record.arguments ?? record.input;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (!args || typeof args !== "object") continue;
    const call = args as Record<string, unknown>;
    if (call.action !== "send") continue;

    // A send to a sibling is collaboration, not a question for the coordinator.
    if (parentAgentName && typeof call.to === "string" && call.to !== parentAgentName) continue;

    const message = typeof call.message === "string" ? call.message.trim() : "";
    if (message) return message;
  }
  return null;
}

function formatAssistantError(message: Record<string, unknown>): string {
  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  const diagnosticMessage = Array.isArray(message.diagnostics)
    ? message.diagnostics
        .map((diagnostic) => {
          if (!diagnostic || typeof diagnostic !== "object") return "";
          const record = diagnostic as Record<string, unknown>;
          const error = record.error;
          if (error && typeof error === "object") {
            const nested = error as Record<string, unknown>;
            if (typeof nested.message === "string" && nested.message.trim()) return nested.message.trim();
          }
          if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
          return "";
        })
        .find((message) => message.length > 0) ?? ""
    : "";
  const base = errorMessage || diagnosticMessage || "assistant response failed";
  return base.startsWith("Error:") ? base : `Error: ${base}`;
}

function quoteShellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)) return value;

  if (/[\n\r\t]/.test(value)) {
    const escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return `$'${escaped}'`;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildLaunchCommand(args: string[]): string {
  return `pi ${args.map(quoteShellArg).join(" ")}`;
}

const INHERITED_PANE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "COLLABORATING_AGENTS_DIR",
  "PI_COLLAB_SUBAGENT_MAX_DEPTH",
  "PI_CODING_AGENT_DIR",
  "CLAUDE_CONFIG_DIR",
] as const;

export function collectInheritedPaneEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_PANE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) inherited[key] = value;
  }
  return inherited;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushSpawnWarning(result: SpawnResult, warning: string): void {
  result.warnings ??= [];
  if (!result.warnings.includes(warning)) result.warnings.push(warning);
}

function formatCallbackWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message ? `Session metadata callback failed: ${message}` : "Session metadata callback failed";
}

function createSessionMetadataNotifier(
  result: SpawnResult,
  callback?: SpawnSessionMetadataCallback,
): {
  notify: (metadata: { sessionId?: string; sessionFile?: string }) => void;
  flush: () => Promise<void>;
} {
  const pending: Promise<void>[] = [];
  let lastMetadataKey: string | undefined;

  const handleFailure = (error: unknown) => {
    pushSpawnWarning(result, formatCallbackWarning(error));
  };

  return {
    notify: (metadata) => {
      if (!callback) return;

      const nextMetadata: SpawnSessionMetadata = { name: result.name };
      if (metadata.sessionId) nextMetadata.sessionId = metadata.sessionId;
      if (metadata.sessionFile) nextMetadata.sessionFile = metadata.sessionFile;

      const metadataKey = `${nextMetadata.sessionId ?? ""}\0${nextMetadata.sessionFile ?? ""}`;
      if (metadataKey === lastMetadataKey) return;
      lastMetadataKey = metadataKey;

      try {
        const maybePromise = callback(nextMetadata);
        if (maybePromise && typeof (maybePromise as Promise<void>).then === "function") {
          pending.push(Promise.resolve(maybePromise).catch(handleFailure));
        }
      } catch (error) {
        handleFailure(error);
      }
    },
    flush: async () => {
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    },
  };
}

function readSelfRegisteredSessionFile(agentName: string, sessionId: string): string | undefined {
  const registrationPath = path.join(resolveDirs().registry, `${agentName}.json`);

  try {
    const parsed = JSON.parse(fs.readFileSync(registrationPath, "utf-8")) as Record<string, unknown>;
    if (parsed.name !== agentName) return undefined;
    if (parsed.sessionId !== sessionId) return undefined;
    return typeof parsed.sessionFile === "string" && parsed.sessionFile.length > 0
      ? parsed.sessionFile
      : undefined;
  } catch {
    return undefined;
  }
}

function createPiEventProcessor(
  result: SpawnResult,
  onSessionMetadata?: (metadata: { sessionId?: string; sessionFile?: string }) => void,
): {
  processLine: (line: string) => void;
  finalize: (stderr: string) => void;
} {
  let lastAssistant = "";
  let assistantError = "";

  const processLine = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (!event || typeof event !== "object") return;
    const e = event as Record<string, unknown>;

    if (e.type === "session") {
      const sessionId = typeof e.id === "string" ? e.id : typeof e.sessionId === "string" ? e.sessionId : undefined;
      if (sessionId) {
        result.sessionId = sessionId;
        result.sessionFile ??= readSelfRegisteredSessionFile(result.name, sessionId);
        if (result.sessionFile) result.sessionFileUnavailableReason = undefined;
        onSessionMetadata?.({ sessionId, sessionFile: result.sessionFile });
        return;
      }
    }

    if ((e.type === "message" || e.type === "message_end") && typeof e.message === "object" && e.message) {
      const msg = e.message as Record<string, unknown>;
      if (msg.role === "assistant") {
        const stopReason =
          typeof msg.stopReason === "string"
            ? msg.stopReason
            : typeof e.stopReason === "string"
              ? e.stopReason
              : e.type === "message_end"
                ? "message_end"
                : undefined;
        if (stopReason === "toolUse") return;

        const text = extractAssistantText(msg.content);
        if (stopReason === "error" || typeof msg.errorMessage === "string") {
          assistantError = formatAssistantError(msg);
          lastAssistant = text || assistantError;
          return;
        }

        assistantError = "";
        lastAssistant = text;
      }
    }
  };

  const finalize = (stderr: string) => {
    if (assistantError) result.error = assistantError;
    result.output = lastAssistant || assistantError || stderr.trim() || "(no output)";
  };

  return { processLine, finalize };
}

async function waitForSessionFileOrExitMarker(args: {
  sessionFile: string;
  exitMarkerPath: string;
  timeoutMs: number;
}): Promise<{ fileExists: boolean; exitCode: number | null; timedOut: boolean }> {
  const timeoutMs = Math.max(100, Math.floor(args.timeoutMs));
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.promises.access(args.sessionFile, fs.constants.F_OK);
      return {
        fileExists: true,
        exitCode: readExitMarkerCode(args.exitMarkerPath),
        timedOut: false,
      };
    } catch {
      const exitCode = readExitMarkerCode(args.exitMarkerPath);
      if (exitCode !== null) {
        return { fileExists: false, exitCode, timedOut: false };
      }
      await sleep(100);
    }
  }

  try {
    await fs.promises.access(args.sessionFile, fs.constants.F_OK);
    return {
      fileExists: true,
      exitCode: readExitMarkerCode(args.exitMarkerPath),
      timedOut: false,
    };
  } catch {
    return {
      fileExists: false,
      exitCode: readExitMarkerCode(args.exitMarkerPath),
      timedOut: true,
    };
  }
}

export function resolveSubagentSessionsDir(): string {
  return path.join(resolveProfileAgentDir(), "sessions", "collaborating-agents-subagents");
}

function createSubagentSessionFilePath(childName: string, runId: string): string {
  const sessionsDir = resolveSubagentSessionsDir();
  fs.mkdirSync(sessionsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(sessionsDir, `${timestamp}_${runId}_${childName}.jsonl`);
}

function createSubagentExitMarkerPath(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

function buildPaneCommand(args: {
  piArgs: string[];
  env: Record<string, string>;
  cwd: string;
  exitMarkerPath: string;
}): string {
  const envAssignments = Object.entries(args.env).map(([key, value]) => `${key}=${quoteShellArg(value)}`);
  const envPrefix = envAssignments.length > 0 ? `env ${envAssignments.join(" ")} ` : "";
  const piCommand = buildLaunchCommand(args.piArgs);
  const cwd = quoteShellArg(args.cwd);
  const exitMarkerPath = quoteShellArg(args.exitMarkerPath);

  return [
    `printf '\\033c'`,
    `cd ${cwd} || exit $?`,
    `${envPrefix}${piCommand}`,
    `status=$?`,
    `mkdir -p $(dirname ${exitMarkerPath})`,
    `printf '%s\\n' "$status" > ${exitMarkerPath}`,
    `rm -f -- "$0"`,
    `exit $status`,
  ].join('; ');
}

function createPaneLaunchScript(args: {
  piArgs: string[];
  env: Record<string, string>;
  cwd: string;
  exitMarkerPath: string;
  childName: string;
  runId: string;
}): { scriptPath: string; command: string } {
  const scriptsDir = path.join(resolveProfileAgentDir(), "tmp", "collaborating-agents-subagents");
  fs.mkdirSync(scriptsDir, { recursive: true });

  const safeChildName = args.childName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const scriptPath = path.join(scriptsDir, `${args.runId.slice(0, 8)}_${safeChildName}.sh`);
  const scriptBody = buildPaneCommand(args);
  const scriptContent = `#!/usr/bin/env bash\n${scriptBody}\n`;
  fs.writeFileSync(scriptPath, scriptContent, { encoding: "utf-8", mode: 0o700 });

  return {
    scriptPath,
    command: `bash ${quoteShellArg(scriptPath)}`,
  };
}

function readExitMarkerCode(exitMarkerPath: string): number | null {
  if (!fs.existsSync(exitMarkerPath)) return null;
  try {
    const code = Number(fs.readFileSync(exitMarkerPath, "utf-8").trim());
    return Number.isFinite(code) ? code : null;
  } catch {
    return null;
  }
}

function readFileChangeToken(filePath: string): FileChangeToken | null {
  try {
    const stats = fs.statSync(filePath);
    return {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

function didFileChange(current: FileChangeToken | null, previous: FileChangeToken | null): boolean {
  if (!current) return false;
  if (!previous) return true;
  // Some session appends can preserve mtime (or land within the same filesystem
  // timestamp quantum), so use size as a second signal instead of relying on
  // mtime alone.
  return Math.abs(current.mtimeMs - previous.mtimeMs) > 0.5 || current.size !== previous.size;
}

function parseSessionMessageLine(
  line: string,
  parentAgentName?: string,
): {
  sessionId?: string;
  terminalAssistantMessage?: boolean;
  terminalAssistantText?: string;
  terminalError?: string;
  toolNames?: string[];
  userMessage?: boolean;
  parentQuestion?: string;
} {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return {};
  }

  if (!event || typeof event !== "object") return {};
  const parsed = event as Record<string, unknown>;

  if (parsed.type === "session") {
    const sessionId = typeof parsed.id === "string" ? parsed.id : typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    if (sessionId) return { sessionId };
  }

  if ((parsed.type !== "message" && parsed.type !== "message_end") || !parsed.message || typeof parsed.message !== "object") {
    return {};
  }

  const message = parsed.message as Record<string, unknown>;
  // A user message is the answer arriving — from the coordinator's reply, or from a
  // human typing into the pane. Either way it clears any question left outstanding.
  if (message.role === "user") return { userMessage: true };
  if (message.role !== "assistant") return {};

  const stopReason =
    typeof message.stopReason === "string"
      ? message.stopReason
      : typeof parsed.stopReason === "string"
        ? parsed.stopReason
        : parsed.type === "message_end"
          ? "message_end"
          : undefined;
  // A toolUse message is not terminal, but it is the only record of what the
  // child is actually doing right now. Surface the tool names for progress
  // reporting instead of discarding the message.
  if (stopReason === "toolUse") {
    return {
      toolNames: extractToolCallNames(message.content),
      parentQuestion: extractParentQuestion(message.content, parentAgentName) ?? undefined,
    };
  }

  const terminalAssistantText = extractAssistantText(message.content);
  if (stopReason === "error" || typeof message.errorMessage === "string") {
    return {
      terminalAssistantMessage: true,
      terminalAssistantText,
      terminalError: formatAssistantError(message),
    };
  }

  return {
    terminalAssistantMessage: true,
    terminalAssistantText,
  };
}

function readSpawnSessionState(
  sessionFile: string,
  parentAgentName?: string,
): {
  sessionId?: string;
  terminalAssistantText?: string;
  terminalError?: string;
  progress?: SubagentProgress;
  pendingQuestion?: string;
  userMessageCount?: number;
} {
  if (!fs.existsSync(sessionFile)) return {};

  let content = "";
  try {
    content = fs.readFileSync(sessionFile, "utf-8");
  } catch {
    return {};
  }

  let sessionId: string | undefined;
  let terminalAssistantText: string | undefined;
  let terminalError: string | undefined;
  let toolCount = 0;
  let lastTool: string | undefined;
  let pendingQuestion: string | undefined;
  let userMessageCount = 0;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseSessionMessageLine(line, parentAgentName);
    if (parsed.sessionId) sessionId = parsed.sessionId;
    if (parsed.toolNames !== undefined) {
      toolCount += parsed.toolNames.length;
      if (parsed.toolNames.length > 0) lastTool = parsed.toolNames[parsed.toolNames.length - 1];
      // Any later tool call means the child asked and then carried on by itself
      // rather than waiting, so there is nothing outstanding to answer.
      if (!parsed.parentQuestion) pendingQuestion = undefined;
      // The child is mid-turn again, so an earlier error (a provider timeout it
      // retried past) or an earlier final text is no longer its last word. Leaving
      // the error in place failed every child that hit one transient timeout and
      // then paused for more than the settle window while still working.
      terminalAssistantText = undefined;
      terminalError = undefined;
    }
    if (parsed.parentQuestion) pendingQuestion = parsed.parentQuestion;
    // The task prompt itself is a user message, so this also clears a question the
    // child somehow asked before reading its task.
    if (parsed.userMessage) {
      pendingQuestion = undefined;
      userMessageCount += 1;
      // A user message opens a new turn, so whatever the child said last is no
      // longer its final word. Without this, a coordinator's reply landing after a
      // "blocked" report was settled instantly on that stale report while the
      // child was still working on the answer.
      terminalAssistantText = undefined;
      terminalError = undefined;
    }
    if (parsed.terminalAssistantMessage) {
      terminalAssistantText = parsed.terminalAssistantText;
      terminalError = parsed.terminalError;
    }
  }

  return {
    sessionId,
    terminalAssistantText,
    terminalError,
    pendingQuestion,
    userMessageCount,
    progress: { toolCount, lastTool },
  };
}

// A pane subagent session can emit multiple assistant messages before it is
// truly done (for example, an interrupted partial response followed by more tool
// work and a later final answer). Assistant error messages can also be transient
// provider failures that the pane recovers from. Wait for the latest successful
// assistant output to remain idle, or for the process to exit/timeout after an
// error, instead of returning the first non-toolUse message we see.
export async function waitForSettledSessionResult(args: {
  sessionFile: string;
  exitMarkerPath: string;
  timeoutMs: number;
  idleGraceMs?: number;
  errorSettleMs?: number;
  parentAgentName?: string;
  /**
   * Ignore any final assistant text recorded before the session holds at least this
   * many user messages. A reply typed into a live pane appears in the transcript
   * only once the child starts its next turn, so until then the file still ends on
   * the answer it gave before the question.
   */
  minUserMessages?: number;
  onUpdate?: (state: { sessionId?: string; progress?: SubagentProgress }) => void;
}): Promise<{
  sessionId?: string;
  terminalAssistantText?: string;
  terminalError?: string;
  awaitingReply?: string;
  exitCode: number | null;
  timedOut: boolean;
}> {
  const idleGraceMs = Math.max(100, Math.floor(args.idleGraceMs ?? PANE_IDLE_GRACE_MS));
  const errorSettleMs = Math.max(idleGraceMs, Math.floor(args.errorSettleMs ?? PANE_ERROR_SETTLE_MS));
  // Treat timeoutMs as an inactivity budget instead of an absolute wall-clock
  // cap. Long-running research subagents can legitimately stay busy for well
  // over 10 minutes; as long as the session file keeps changing, keep waiting.
  const inactivityTimeoutMs = Math.max(idleGraceMs, Math.floor(args.timeoutMs));
  const hardTimeoutMs = Math.max(
    inactivityTimeoutMs,
    inactivityTimeoutMs * PANE_MAX_IDLE_TIMEOUT_MULTIPLIER,
    inactivityTimeoutMs + PANE_MAX_IDLE_TIMEOUT_BUFFER_MS,
  );
  const startedAt = Date.now();
  let activityDeadlineAt = startedAt + inactivityTimeoutMs;
  let lastObservedToken = readFileChangeToken(args.sessionFile);
  let lastParsedToken: FileChangeToken | null = null;
  let lastActivityAt = Date.now();
  let sessionId: string | undefined;
  let terminalAssistantText: string | undefined;
  let terminalError: string | undefined;
  let pendingQuestion: string | undefined;
  let lastReportedToolCount = 0;

  while (Date.now() - startedAt < hardTimeoutMs && Date.now() < activityDeadlineAt) {
    const currentToken = readFileChangeToken(args.sessionFile);
    if (didFileChange(currentToken, lastObservedToken)) {
      lastObservedToken = currentToken;
      lastActivityAt = Date.now();
      activityDeadlineAt = lastActivityAt + inactivityTimeoutMs;
    }

    if (lastParsedToken === null || didFileChange(currentToken, lastParsedToken)) {
      const state = readSpawnSessionState(args.sessionFile, args.parentAgentName);
      const turnStarted = (state.userMessageCount ?? 0) >= (args.minUserMessages ?? 0);
      pendingQuestion = turnStarted ? state.pendingQuestion : undefined;
      if (state.sessionId) {
        sessionId = state.sessionId;
        args.onUpdate?.({ sessionId });
      }
      if (state.progress && state.progress.toolCount > lastReportedToolCount) {
        lastReportedToolCount = state.progress.toolCount;
        args.onUpdate?.({ sessionId, progress: state.progress });
      }
      // The whole file is re-read each time, so its verdict is authoritative: a new
      // turn clears the previous final text instead of leaving it sticky here.
      terminalAssistantText = turnStarted ? state.terminalAssistantText : undefined;
      terminalError = turnStarted ? state.terminalError : undefined;
      if (currentToken) {
        lastParsedToken = currentToken;
      }
    }

    const exitCode = readExitMarkerCode(args.exitMarkerPath);
    if (exitCode !== null) {
      if (exitCode !== 0 || terminalError !== undefined) {
        return { sessionId, terminalAssistantText, terminalError, exitCode, timedOut: false };
      }

      // If the pane process has already exited cleanly, the session file is no
      // longer changing. Once we have a terminal assistant message, return
      // immediately instead of burning the full idle-grace budget. This keeps
      // sequential synchronous pane spawns fast while preserving the grace
      // period for still-running panes that may emit more output.
      if (terminalAssistantText !== undefined) {
        return { sessionId, terminalAssistantText, exitCode, timedOut: false };
      }
    }

    // An outstanding question outranks the idle check: the child is quiet because it
    // is waiting for the coordinator, not because it is done. Hand the question back
    // with the session still alive so the answer can be delivered into it.
    if (
      pendingQuestion !== undefined &&
      exitCode === null &&
      terminalError === undefined &&
      Date.now() - lastActivityAt >= idleGraceMs
    ) {
      return { sessionId, terminalAssistantText, awaitingReply: pendingQuestion, exitCode, timedOut: false };
    }

    if (terminalAssistantText !== undefined && terminalError === undefined && Date.now() - lastActivityAt >= idleGraceMs) {
      return { sessionId, terminalAssistantText, terminalError, exitCode, timedOut: false };
    }

    if (terminalError !== undefined && Date.now() - lastActivityAt >= errorSettleMs) {
      return { sessionId, terminalAssistantText, terminalError, exitCode, timedOut: false };
    }

    await sleep(100);
  }

  const exitCode = readExitMarkerCode(args.exitMarkerPath);
  if (exitCode !== null && (exitCode !== 0 || terminalError !== undefined)) {
    return { sessionId, terminalAssistantText, terminalError, exitCode, timedOut: false };
  }

  if (terminalAssistantText !== undefined && terminalError === undefined && Date.now() - lastActivityAt >= idleGraceMs) {
    return { sessionId, terminalAssistantText, terminalError, exitCode, timedOut: false };
  }

  if (terminalError !== undefined) {
    return { sessionId, terminalAssistantText, terminalError, exitCode, timedOut: false };
  }

  return {
    sessionId,
    terminalAssistantText,
    terminalError,
    exitCode,
    timedOut: true,
  };
}

function findSurfacePaneRef(snapshot: Map<string, string[]>, surfaceRef: string): string | undefined {
  for (const [paneRef, surfaceRefs] of snapshot.entries()) {
    if (surfaceRefs.includes(surfaceRef)) return paneRef;
  }
  return undefined;
}

function syncPaneLayoutStateWithSnapshot(state: PaneWorkspaceLayoutState, snapshot: Map<string, string[]>): void {
  const paneRefs = new Set(snapshot.keys());

  const leaves = collectPaneLayoutLeaves(state.root);
  for (const leaf of leaves) {
    const actualPaneRef = findSurfacePaneRef(snapshot, leaf.surfaceRef);
    if (actualPaneRef) {
      if (!paneRefs.has(leaf.paneRef)) {
        leaf.paneRef = actualPaneRef;
      }
      continue;
    }

    if (leaf.role === "subagent") {
      removePaneFromLayout(state.workspaceRef, {
        paneRef: leaf.paneRef,
        surfaceRef: leaf.surfaceRef,
      });
    }
  }

  const orchestratorLeaf = findPaneLayoutLeaf(state.root, (leaf) => leaf.role === "orchestrator");
  const actualOrchestratorPane = orchestratorLeaf ? findSurfacePaneRef(snapshot, orchestratorLeaf.surfaceRef) : undefined;
  if (orchestratorLeaf && actualOrchestratorPane && !paneRefs.has(orchestratorLeaf.paneRef)) {
    orchestratorLeaf.paneRef = actualOrchestratorPane;
    state.orchestratorPaneRef = actualOrchestratorPane;
  }
}

/**
 * Herdr has no surface layer, so a pane id is the whole identity. Reporting it
 * as both refs lets the shared layout tree, the run store and every downstream
 * consumer stay mode-agnostic.
 */
async function snapshotHerdrWorkspace(workspaceId: string): Promise<Map<string, string[]>> {
  const panes = await herdrListPanes(workspaceId);
  if (!panes.ok) return new Map();

  const snapshot = new Map<string, string[]>();
  for (const pane of panes.value) {
    snapshot.set(pane.paneId, [pane.paneId]);
  }

  return snapshot;
}

async function launchHerdrPane(args: {
  scriptPath: string;
  preserveOrchestratorPane: boolean;
  cwd: string;
}): Promise<
  | {
      ok: true;
      workspaceRef: string;
      paneRef: string;
      surfaceRef: string;
    }
  | {
      ok: false;
      error: string;
    }
> {
  return await withPaneLayoutLock(async () => {
    // Herdr exports HERDR_PANE_ID into every pane it launches, which is both
    // cheaper and more reliable than asking the server who the caller is.
    const caller = herdrCallerPaneFromEnv();
    if (!caller) {
      return {
        ok: false,
        error: "herdr pane launch requires running inside a herdr pane (HERDR_ENV/HERDR_PANE_ID are unset)",
      };
    }

    const callerContext = {
      workspaceRef: caller.workspaceId,
      paneRef: caller.paneId,
      surfaceRef: caller.paneId,
    };

    const layoutState = getOrCreatePaneWorkspaceLayout(callerContext);
    const beforeSnapshot = await snapshotHerdrWorkspace(caller.workspaceId);
    if (beforeSnapshot.size > 0) {
      syncPaneLayoutStateWithSnapshot(layoutState, beforeSnapshot);
    }

    let splitTarget = choosePaneSplitLeaf(layoutState, args.preserveOrchestratorPane);
    let split = await herdrSplitPane({
      paneId: splitTarget.paneRef,
      direction: choosePaneSplitDirection(splitTarget),
      cwd: args.cwd,
    });

    // A subagent pane the user closed by hand is still in our tree; drop it and
    // retry once against whatever is actually left.
    if (!split.ok && splitTarget.role !== "orchestrator") {
      removePaneFromLayout(caller.workspaceId, {
        paneRef: splitTarget.paneRef,
        surfaceRef: splitTarget.surfaceRef,
      });
      splitTarget = choosePaneSplitLeaf(layoutState, args.preserveOrchestratorPane);
      split = await herdrSplitPane({
        paneId: splitTarget.paneRef,
        direction: choosePaneSplitDirection(splitTarget),
        cwd: args.cwd,
      });
    }

    if (!split.ok) {
      return { ok: false, error: split.error };
    }

    const created = split.value;
    applyPaneSplitToLayout(layoutState, splitTarget, created.paneId, created.paneId);

    const send = await herdrSendLine(created.paneId, args.scriptPath);
    if (!send.ok) {
      // The pane exists but will never run anything; leaving it behind would
      // shrink the workspace for every later split.
      await herdrClosePane(created.paneId);
      removePaneFromLayout(caller.workspaceId, { paneRef: created.paneId, surfaceRef: created.paneId });
      return { ok: false, error: send.error };
    }

    return {
      ok: true,
      workspaceRef: created.workspaceId,
      paneRef: created.paneId,
      surfaceRef: created.paneId,
    };
  });
}

/** True for the launch modes that put a subagent in its own terminal pane. */
export function isPaneLaunchMode(mode: SubagentLaunchMode): boolean {
  return mode === "herdr-pane";
}

async function launchSubagentPane(
  args: { scriptPath: string; preserveOrchestratorPane: boolean; cwd: string },
): Promise<
  { ok: true; workspaceRef: string; paneRef: string; surfaceRef: string } | { ok: false; error: string }
> {
  return await launchHerdrPane(args);
}

async function closeSubagentPane(
  refs: { paneRef?: string; surfaceRef: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const closed = await herdrClosePane(refs.paneRef ?? refs.surfaceRef);
  return closed.ok ? { ok: true } : { ok: false, error: closed.error };
}

/**
 * Best-effort terminal capture used only to enrich failure messages, so both
 * backends degrade to an empty string rather than surfacing their own errors.
 */
async function readSubagentPaneScreen(
  refs: { paneRef?: string; surfaceRef?: string },
  lines: number,
): Promise<string> {
  const paneRef = refs.paneRef ?? refs.surfaceRef;
  return paneRef ? await herdrReadPane(paneRef, lines) : "";
}

export type ReplyOutcome =
  | {
      ok: true;
      output?: string;
      awaitingReply?: string;
      sessionId?: string;
      timedOut: boolean;
      paneClosed?: boolean;
      paneCloseError?: string;
    }
  | { ok: false; error: string };

export interface ReplyToSubagentArgs {
  launchMode: SubagentLaunchMode;
  paneRef?: string;
  surfaceRef?: string;
  sessionFile: string;
  message: string;
  timeoutMs?: number;
  parentAgentName?: string;
  /** Close the child's pane once the resumed turn ends on a real result. */
  closePaneOnFinish?: boolean;
  onProgress?: (progress: SubagentProgress) => void;
}

/**
 * Type an answer into a child that stopped on a question, and hand back the wait
 * for what it does next as a promise.
 *
 * The answer goes into the child's live pane, which the TUI reads as ordinary user
 * input and turns into a new turn — so the child keeps everything it had already
 * worked out instead of being replaced by a fresh spawn. Delivery is confirmed
 * before this returns; the resumed turn can take as long as the original run, so
 * the caller decides whether to block on `outcome` or collect it in the background.
 */
export async function startReplyToSubagent(
  args: ReplyToSubagentArgs,
): Promise<{ ok: true; outcome: Promise<ReplyOutcome> } | { ok: false; error: string }> {
  const answer = args.message.replace(/\s*\n\s*/g, " ").trim();
  if (!answer) return { ok: false, error: "Reply message is empty." };

  if (args.launchMode !== "herdr-pane") {
    return {
      ok: false,
      error: `Replying to a live subagent is implemented for herdr-pane only; this one ran under ${args.launchMode}.`,
    };
  }

  const paneRef = args.paneRef ?? args.surfaceRef;
  if (!paneRef) return { ok: false, error: "No pane reference recorded for this subagent." };

  // A pane that has already gone means the child exited between the question and
  // the answer; say so rather than reporting a delivery that never happened.
  const exitMarkerPath = createSubagentExitMarkerPath(args.sessionFile);
  if (readExitMarkerCode(exitMarkerPath) !== null) {
    return { ok: false, error: "The subagent has already exited; its session cannot be resumed." };
  }

  // Everything in the transcript so far belongs to the turn that ended on the
  // question. The result of this reply is whatever the child says after one more
  // user message (the answer) has been recorded.
  const before = readSpawnSessionState(args.sessionFile, args.parentAgentName);
  const minUserMessages = (before.userMessageCount ?? 0) + 1;

  const delivered = await herdrSendLine(paneRef, answer);
  if (!delivered.ok) return { ok: false, error: `Could not deliver the reply: ${delivered.error}` };

  const outcome = (async (): Promise<ReplyOutcome> => {
    const settled = await waitForSettledSessionResult({
      sessionFile: args.sessionFile,
      exitMarkerPath,
      timeoutMs: args.timeoutMs ?? PANE_RESULT_TIMEOUT_MS,
      parentAgentName: args.parentAgentName,
      minUserMessages,
      onUpdate: (state) => {
        if (state.progress) args.onProgress?.(state.progress);
      },
    });

    if (settled.terminalError !== undefined) return { ok: false, error: settled.terminalError };

    const result: ReplyOutcome = {
      ok: true,
      output: settled.terminalAssistantText,
      awaitingReply: settled.awaitingReply,
      sessionId: settled.sessionId,
      timedOut: settled.timedOut,
    };

    // Same rule as a fresh spawn: a finished child's pane is released, a parked or
    // timed-out one stays open for inspection and for the next answer.
    if (args.closePaneOnFinish && settled.awaitingReply === undefined && !settled.timedOut && settled.terminalAssistantText !== undefined) {
      const closed = await closeSubagentPane({ paneRef: args.paneRef, surfaceRef: paneRef });
      if (closed.ok) result.paneClosed = true;
      else result.paneCloseError = closed.error;
    }
    return result;
  })();

  return { ok: true, outcome };
}

/**
 * Answer a child that stopped on a question and wait for its real result.
 * Convenience wrapper over `startReplyToSubagent` for callers that can block.
 */
export async function replyToSubagent(args: ReplyToSubagentArgs): Promise<ReplyOutcome> {
  const started = await startReplyToSubagent(args);
  if (!started.ok) return started;
  return await started.outcome;
}

export async function runSpawnTask(
  runtimeCwd: string,
  task: SpawnTask,
  agentDef: SpawnAgentDefinition,
  options: {
    index: number;
    runId: string;
    defaultCwd?: string;
    recursionDepth: number;
    parentAgentName?: string;
    launchDelayMs?: number;
    launchMode?: SubagentLaunchMode;
    /** Pi config directory for the child; overrides the inherited PI_CODING_AGENT_DIR. */
    agentDir?: string;
    closeCompletedPane?: boolean;
    closeFailedPane?: boolean;
    preserveOrchestratorPane?: boolean;
    paneResultTimeoutMs?: number;
    onLaunch?: (launch: SpawnResult) => void | Promise<void>;
    onSessionMetadata?: SpawnSessionMetadataCallback;
    onProgress?: SubagentProgressCallback;
  },
): Promise<SpawnResult> {
  const generatedCallsign = reserveReadableCallsign(options.runId, options.index);
  const runToken = options.runId.slice(0, 4);
  const childName = sanitizeAgentName(`${task.agent}-${runToken}-${generatedCallsign}`);

  const commonArgs: string[] = [];
  // --session-control is not a flag any released pi supports (checked
  // @mariozechner 0.53-0.73 and @earendil-works 0.74-0.80.9); passing it makes
  // every child exit with "Unknown option" before it starts.

  const model = agentDef.model;
  if (model) commonArgs.push("--models", model);

  const requestedTools = [...new Set((agentDef.tools ?? []).map((tool) => tool.trim()).filter(Boolean))];

  if (requestedTools.length > 0) {
    commonArgs.push("--tools", requestedTools.join(","));
  }

  // Ensure the collaborating-agents extension is always loaded in subagents so
  // requested extension tools such as `agent_message` can be registered and
  // activated by the --tools allow-list, even if auto-discovery is unavailable.
  const extensionPaths = [
    LOCAL_COLLABORATING_AGENTS_EXTENSION,
    HOME_COLLABORATING_AGENTS_EXTENSION,
  ];
  for (const extensionPath of extensionPaths) {
    if (fs.existsSync(extensionPath)) {
      commonArgs.push("--extension", extensionPath);
      break;
    }
  }

  const typeSystemPrompt = agentDef.systemPrompt.trim();
  if (typeSystemPrompt) {
    // Pass prompt text directly so type instructions are always attached,
    // regardless of file-path resolution behavior across pi versions.
    commonArgs.push("--append-system-prompt", typeSystemPrompt);
  }

  const parentContextHeader = options.parentAgentName
    ? `Parent agent: ${options.parentAgentName}\n\n`
    : "";

  // Keep the task prompt payload user-controlled (type instructions come from TOML
  // via --append-system-prompt). Only add lightweight parent context metadata.
  const wrappedTaskPrompt = `${parentContextHeader}${task.task}`;
  const childAgentDir = options.agentDir?.trim() || undefined;
  // The child must talk on the parent's bus even when it runs in a different Pi
  // profile, where the default would resolve to that profile's own directory.
  const collabDir = resolveDirs().base;
  const env = {
    ...process.env,
    PI_AGENT_NAME: childName,
    PI_COLLAB_SUBAGENT_DEPTH: String(options.recursionDepth + 1),
    COLLABORATING_AGENTS_DIR: collabDir,
    ...(childAgentDir ? { PI_CODING_AGENT_DIR: childAgentDir } : {}),
  };

  const cwd = task.cwd || options.defaultCwd || runtimeCwd;

  const launchMode = options.launchMode ?? "process";
  // Process-mode uses Pi JSON events for the first iteration. We do not pass
  // `--session` here until support is proven end-to-end, so transcript tailing
  // is best-effort until child registration or a fallback scan finds a file.
  const sessionFile = isPaneLaunchMode(launchMode) ? createSubagentSessionFilePath(childName, options.runId.slice(0, 8)) : undefined;
  const exitMarkerPath = sessionFile ? createSubagentExitMarkerPath(sessionFile) : undefined;

  const args: string[] =
    isPaneLaunchMode(launchMode)
      ? [...commonArgs, "--session", sessionFile!, wrappedTaskPrompt]
      : ["--mode", "json", "-p", ...commonArgs, wrappedTaskPrompt];

  const launchArgs = [...args];
  if (typeSystemPrompt) {
    const promptArgIndex = launchArgs.indexOf("--append-system-prompt");
    if (promptArgIndex >= 0 && promptArgIndex + 1 < launchArgs.length) {
      launchArgs[promptArgIndex + 1] = `<subagent-type-prompt:${typeSystemPrompt.length} chars>`;
    }
  }

  const launchDelayMs = Math.max(0, Math.floor(options.launchDelayMs ?? 0));
  const paneResultTimeoutMs = Math.max(100, Math.floor(options.paneResultTimeoutMs ?? PANE_RESULT_TIMEOUT_MS));

  const result: SpawnResult = {
    agent: task.agent,
    name: childName,
    task: task.task,
    exitCode: 1,
    output: "",
    sessionFile,
    sessionFileUnavailableReason: launchMode === "process" ? PROCESS_MODE_SESSION_FILE_UNAVAILABLE_REASON : undefined,
    launchMode,
    workingDirectory: cwd,
    launchArgs,
    launchCommand: buildLaunchCommand(launchArgs),
    launchPrompt: wrappedTaskPrompt,
    launchSystemPromptSource: typeSystemPrompt ? agentDef.filePath : undefined,
    launchSystemPromptLength: typeSystemPrompt.length > 0 ? typeSystemPrompt.length : undefined,
    launchEnv: {
      PI_AGENT_NAME: childName,
      PI_COLLAB_SUBAGENT_DEPTH: String(options.recursionDepth + 1),
      COLLABORATING_AGENTS_DIR: collabDir,
      ...(childAgentDir ? { PI_CODING_AGENT_DIR: childAgentDir } : {}),
    },
    launchDelayMs,
    resolvedModel: model,
    resolvedTools: requestedTools.length > 0 ? [...requestedTools] : undefined,
    coordinator: options.parentAgentName,
  };
  const sessionMetadata = createSessionMetadataNotifier(result, options.onSessionMetadata);

  if (launchDelayMs > 0) {
    await sleep(launchDelayMs);
  }

  if (isPaneLaunchMode(result.launchMode)) {
    const paneLaunchEnv: Record<string, string> = {
      ...collectInheritedPaneEnv(),
      PI_AGENT_NAME: result.launchEnv.PI_AGENT_NAME,
      PI_COLLAB_SUBAGENT_DEPTH: result.launchEnv.PI_COLLAB_SUBAGENT_DEPTH,
      // Pin the parent's bus here too: with PI_CODING_AGENT_DIR pointing at another
      // profile, the child would otherwise resolve that profile's own empty bus and
      // neither side could message the other (2026-09-09, browser-verify child).
      COLLABORATING_AGENTS_DIR: result.launchEnv.COLLABORATING_AGENTS_DIR,
      ...(result.launchEnv.PI_CODING_AGENT_DIR
        ? { PI_CODING_AGENT_DIR: result.launchEnv.PI_CODING_AGENT_DIR }
        : {}),
    };

    const paneLaunchScript = createPaneLaunchScript({
      piArgs: args,
      env: paneLaunchEnv,
      cwd,
      exitMarkerPath: exitMarkerPath!,
      childName,
      runId: options.runId,
    });

    const paneLaunch = await launchSubagentPane({
      scriptPath: paneLaunchScript.command,
      preserveOrchestratorPane: options.preserveOrchestratorPane ?? false,
      cwd,
    });

    if (!paneLaunch.ok) {
      try {
        fs.unlinkSync(paneLaunchScript.scriptPath);
      } catch {
        // ignore best-effort cleanup failures
      }
      result.exitCode = 1;
      result.error = paneLaunch.error;
      result.output = result.error;
      return result;
    }

    result.workspaceRef = paneLaunch.workspaceRef;
    result.paneRef = paneLaunch.paneRef;
    result.surfaceRef = paneLaunch.surfaceRef;

    // Every terminal outcome now runs through one release point instead of the
    // failure paths returning early and leaking the pane. A failed pane is still
    // kept on screen by default so the failure can be read where it happened;
    // `closeFailedPanes` opts into closing it, which is what an orchestrator
    // that retries after a provider error wants, so retries stop stacking fresh
    // panes on top of dead ones. Failure detail survives in the durable run
    // record and the session file either way.
    const releasePane = async (outcome: "completed" | "failed" = "completed"): Promise<SpawnResult> => {
      if (outcome === "failed" && options.closeFailedPane !== true) return result;
      if (outcome === "completed" && options.closeCompletedPane === false) return result;
      if (!result.surfaceRef) return result;
      const closeResult = await closeSubagentPane({
        paneRef: result.paneRef,
        surfaceRef: result.surfaceRef,
      });
      if (closeResult.ok) {
        result.paneClosed = true;
        if (result.workspaceRef) {
          await withPaneLayoutLock(async () => {
            removePaneFromLayout(result.workspaceRef!, {
              paneRef: result.paneRef,
              surfaceRef: result.surfaceRef,
            });
          });
        }
      } else {
        result.paneCloseError = closeResult.error;
      }
      return result;
    };

    if (options.onLaunch) {
      const launchSnapshot: SpawnResult = {
        ...result,
        launchArgs: [...result.launchArgs],
        launchEnv: { ...result.launchEnv },
        resolvedTools: result.resolvedTools ? [...result.resolvedTools] : undefined,
      };
      void Promise.resolve(options.onLaunch(launchSnapshot)).catch(() => {
        // ignore launch callback errors
      });
    }

    const sessionFileWait = await waitForSessionFileOrExitMarker({
      sessionFile: result.sessionFile!,
      exitMarkerPath: exitMarkerPath!,
      timeoutMs: paneResultTimeoutMs,
    });
    if (!sessionFileWait.fileExists) {
      result.exitCode = sessionFileWait.exitCode ?? 1;
      const paneScreen = await readSubagentPaneScreen(result, 120);
      const defaultError = sessionFileWait.exitCode !== null
        ? `${result.launchMode} subagent exited with code ${sessionFileWait.exitCode} before creating its session file`
        : "Timed out waiting for subagent session file in pane";
      result.error = paneScreen || defaultError;
      result.output = result.error;
      return await releasePane("failed");
    }

    const sessionState = await waitForSettledSessionResult({
      sessionFile: result.sessionFile!,
      exitMarkerPath: exitMarkerPath!,
      timeoutMs: paneResultTimeoutMs,
      parentAgentName: options.parentAgentName,
      onUpdate: (state) => {
        if (state.sessionId) {
          result.sessionId = state.sessionId;
          sessionMetadata.notify({ sessionId: state.sessionId, sessionFile: result.sessionFile });
        }
        if (state.progress) options.onProgress?.(state.progress);
      },
    });
    await sessionMetadata.flush();

    // The child is waiting on an answer, not finished. Leave the pane open and hand
    // the question up; `replyToSubagent` resumes this same session once answered.
    if (sessionState.awaitingReply !== undefined) {
      result.sessionId = sessionState.sessionId ?? result.sessionId;
      result.awaitingReply = sessionState.awaitingReply;
      result.output = sessionState.terminalAssistantText?.trim() || sessionState.awaitingReply;
      result.exitCode = 0;
      return result;
    }

    if (sessionState.terminalError !== undefined) {
      result.sessionId = sessionState.sessionId ?? result.sessionId;
      result.output = sessionState.terminalAssistantText?.trim() || sessionState.terminalError;
      result.exitCode = sessionState.exitCode !== null && sessionState.exitCode !== 0 ? sessionState.exitCode : 1;
      result.error = sessionState.terminalError;
      return await releasePane("failed");
    }

    if (sessionState.exitCode !== null && sessionState.exitCode !== 0) {
      result.sessionId = sessionState.sessionId ?? result.sessionId;
      result.output = sessionState.terminalAssistantText || "(no output)";
      result.exitCode = sessionState.exitCode;

      if (sessionState.terminalAssistantText === undefined) {
        const paneScreen = await readSubagentPaneScreen(result, 200);
        if (paneScreen) {
          result.output = paneScreen;
          result.error = paneScreen;
        }
      }

      result.error = result.error ?? `${result.launchMode} subagent exited with code ${sessionState.exitCode}`;
      return await releasePane("failed");
    }

    if (sessionState.terminalAssistantText === undefined || sessionState.timedOut) {
      const paneScreen = await readSubagentPaneScreen(result, 200);
      result.exitCode = 1;
      result.error = paneScreen || "Timed out waiting for settled subagent response in pane";
      result.output = result.error;
      return await releasePane("failed");
    }

    result.sessionId = sessionState.sessionId ?? result.sessionId;
    result.output = sessionState.terminalAssistantText || "(no output)";
    result.exitCode = sessionState.exitCode ?? 0;

    if (result.exitCode !== 0) {
      result.error = result.error ?? `${result.launchMode} subagent exited with code ${result.exitCode}`;
      return await releasePane("failed");
    }

    return await releasePane();
  }

  result.exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const processor = createPiEventProcessor(result, sessionMetadata.notify);

      if (options.onLaunch) {
        const launchSnapshot: SpawnResult = {
          ...result,
          launchArgs: [...result.launchArgs],
          launchEnv: { ...result.launchEnv },
          resolvedTools: result.resolvedTools ? [...result.resolvedTools] : undefined,
        };
        void Promise.resolve(options.onLaunch(launchSnapshot)).catch(() => {
          // ignore launch callback errors
        });
      }

      let stdoutBuffer = "";
      let stderr = "";

      proc.stdout.on("data", (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) processor.processLine(line);
      });

      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) processor.processLine(stdoutBuffer);
        processor.finalize(stderr);
        const stderrText = stderr.trim();
        if ((code ?? 0) !== 0 && stderrText && !result.error) result.error = stderrText;
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        result.error = err instanceof Error ? err.message : String(err);
        result.output = result.error;
        resolve(1);
      });
    });

  await sessionMetadata.flush();

  if (result.error && result.exitCode === 0) {
    result.exitCode = 1;
  }

  if (result.exitCode !== 0 && !result.error) {
    result.error = result.output || "Subagent process failed";
  }

  return result;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const max = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(max).fill(null).map(async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]!, idx);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Create a SpawnAgentDefinition from a SubagentTypeConfig.
 * This converts TOML-based subagent type configurations to the format
 * needed by the spawn system.
 */
export function createSpawnAgentDefinitionFromType(
  typeConfig: SubagentTypeConfig,
): SpawnAgentDefinition {
  return {
    name: typeConfig.name,
    description: typeConfig.description,
    model: typeConfig.model,
    // A type may widen or narrow the tool set; without one it gets the default
    // five, which is what every type got before types could ask.
    tools: typeConfig.tools?.length ? [...typeConfig.tools] : [...DEFAULT_SUBAGENT_TOOLS],
    systemPrompt: typeConfig.prompt,
    source: typeConfig.source,
    filePath: typeConfig.filePath,
  };
}
