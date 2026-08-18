import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelFallbackConfig {
  enabled: boolean;
  orchestratorOnly: boolean;
  chain: ChainEntry[];
  resumeText: string;
  coldStartResumeText: string;
  notifyUser: boolean;
  /**
   * Chain entries that cost real money. Switching onto one of these emits
   * `paidNoticeText` at "error" level so it renders red — the subscription
   * pools are gone at that point and every further turn is billed.
   */
  paidEntries: ChainEntry[];
  paidNoticeText: string;
  /**
   * Per-entry context-size hazards. Switching onto one of these while the
   * observed context exceeds `aboveTokens` emits a warning — a fresh provider
   * with a smaller (or overridden) window silently triggers auto-compaction or
   * long-context pricing, neither of which surfaces anywhere else.
   */
  contextWarnings: ContextWarning[];
  /**
   * Treat an unresolved overflow compaction as a switch trigger. Pi runs
   * overflow recovery through a path that emits no extension-visible failure,
   * so a compaction that dies on an exhausted provider would otherwise stall
   * the chain forever.
   */
  advanceOnCompactionFailure: boolean;
  compactionFailureNoticeText: string;
  /**
   * Continuation text for a compaction-failure switch. Separate from
   * `resumeText` because that one asserts an exhausted quota, which is a false
   * premise here — a dead compaction says nothing about why it died.
   */
  compactionFailureResumeText: string;
}

export interface ChainEntry {
  provider: string;
  id: string;
}

export interface ContextWarning {
  entry: ChainEntry;
  aboveTokens: number;
  text: string;
}

export const DEFAULT_RESUME_TEXT =
  "The previous provider exhausted its quota. Continue the current task from where it stopped; do not redo completed work.";

// The default resume text asserts that work was interrupted. When the provider
// rejects the very first request of a turn there is no such work, and telling a
// fresh model to "continue from where it stopped" makes it go hunting for a task
// that does not exist — on the paid tail of the chain, that hunt is billed.
export const DEFAULT_COLD_START_RESUME_TEXT =
  "The previous provider rejected the request before producing any output, so there is no partial work to resume. Answer the user's last message on this model.";

export const DEFAULT_PAID_NOTICE_TEXT =
  "\u0412\u0421\u0406 \u041b\u0406\u041c\u0406\u0422\u0418 \u0412\u0418\u0427\u0415\u0420\u041f\u0410\u041d\u0406 \u2014 \u043f\u0440\u0430\u0446\u044e\u0454\u043c\u043e \u043d\u0430 \u043f\u043b\u0430\u0442\u043d\u0456\u0439 \u043e\u0441\u043d\u043e\u0432\u0456";

export const DEFAULT_CONTEXT_WARNING_TEXT =
  "model-fallback: context exceeds this model's comfortable window — run /compact before continuing or switch to a wider-window model, since auto-compaction on a fresh provider can fail and stall the chain.";

export const DEFAULT_COMPACTION_FAILURE_NOTICE_TEXT =
  "model-fallback: auto-compaction did not complete on the previous model; advancing the chain because of it.";

export const DEFAULT_COMPACTION_FAILURE_RESUME_TEXT =
  "Auto-compaction did not complete on the previous model, so the context may be near its limit. Continue the current task from where the previous model stopped; do not redo completed work.";

export const DEFAULT_CONFIG: ModelFallbackConfig = {
  enabled: false,
  orchestratorOnly: true,
  chain: [],
  resumeText: DEFAULT_RESUME_TEXT,
  coldStartResumeText: DEFAULT_COLD_START_RESUME_TEXT,
  notifyUser: true,
  paidEntries: [],
  paidNoticeText: DEFAULT_PAID_NOTICE_TEXT,
  contextWarnings: [],
  advanceOnCompactionFailure: true,
  compactionFailureNoticeText: DEFAULT_COMPACTION_FAILURE_NOTICE_TEXT,
  compactionFailureResumeText: DEFAULT_COMPACTION_FAILURE_RESUME_TEXT,
};

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;
  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;
  return homedir();
}

// Mirrors how Pi itself locates its agent directory, so a second instance
// started with PI_CODING_AGENT_DIR (e.g. a personal profile alongside a work
// one) reads its own chain instead of the default profile's. Falls back to
// ~/.pi/agent when the variable is unset.
function resolveAgentDir(): string {
  const envAgentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envAgentDir) return envAgentDir;
  return join(resolveHomeDir(), ".pi", "agent");
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseChainEntry(raw: unknown): ChainEntry | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) return null;
  const provider = trimmed.slice(0, slashIndex).trim();
  const id = trimmed.slice(slashIndex + 1).trim();
  if (!provider || !id) return null;
  return { provider, id };
}

function normalizeChain(raw: unknown): ChainEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ChainEntry[] = [];
  for (const item of raw) {
    const entry = parseChainEntry(item);
    if (entry) out.push(entry);
  }
  return out;
}

function normalizeContextWarnings(raw: unknown): ContextWarning[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextWarning[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const entry = parseChainEntry(record.entry);
    if (!entry) continue;
    const aboveTokens = record.aboveTokens;
    if (typeof aboveTokens !== "number" || !Number.isFinite(aboveTokens) || aboveTokens <= 0) {
      continue;
    }
    const text =
      typeof record.text === "string" && record.text.trim().length > 0
        ? record.text
        : DEFAULT_CONTEXT_WARNING_TEXT;
    out.push({ entry, aboveTokens, text });
  }
  return out;
}

function mergeRaw(
  ...sources: Array<Record<string, unknown> | null>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      merged[key] = value;
    }
  }
  return merged;
}

export function normalizeConfig(raw: Record<string, unknown>): ModelFallbackConfig {
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    orchestratorOnly:
      typeof raw.orchestratorOnly === "boolean"
        ? raw.orchestratorOnly
        : DEFAULT_CONFIG.orchestratorOnly,
    chain: normalizeChain(raw.chain),
    resumeText:
      typeof raw.resumeText === "string" && raw.resumeText.trim().length > 0
        ? raw.resumeText
        : DEFAULT_CONFIG.resumeText,
    coldStartResumeText:
      typeof raw.coldStartResumeText === "string" && raw.coldStartResumeText.trim().length > 0
        ? raw.coldStartResumeText
        : DEFAULT_CONFIG.coldStartResumeText,
    notifyUser: typeof raw.notifyUser === "boolean" ? raw.notifyUser : DEFAULT_CONFIG.notifyUser,
    paidEntries: normalizeChain(raw.paidEntries),
    paidNoticeText:
      typeof raw.paidNoticeText === "string" && raw.paidNoticeText.trim().length > 0
        ? raw.paidNoticeText
        : DEFAULT_CONFIG.paidNoticeText,
    contextWarnings: normalizeContextWarnings(raw.contextWarnings),
    advanceOnCompactionFailure:
      typeof raw.advanceOnCompactionFailure === "boolean"
        ? raw.advanceOnCompactionFailure
        : DEFAULT_CONFIG.advanceOnCompactionFailure,
    compactionFailureNoticeText:
      typeof raw.compactionFailureNoticeText === "string" &&
      raw.compactionFailureNoticeText.trim().length > 0
        ? raw.compactionFailureNoticeText
        : DEFAULT_CONFIG.compactionFailureNoticeText,
    compactionFailureResumeText:
      typeof raw.compactionFailureResumeText === "string" &&
      raw.compactionFailureResumeText.trim().length > 0
        ? raw.compactionFailureResumeText
        : DEFAULT_CONFIG.compactionFailureResumeText,
  };
}

/** Case-insensitive membership test used to decide if a switch is billable. */
export function isPaidEntry(config: ModelFallbackConfig, entry: ChainEntry): boolean {
  return config.paidEntries.some(
    (paid) =>
      paid.provider.toLowerCase() === entry.provider.toLowerCase() &&
      paid.id.toLowerCase() === entry.id.toLowerCase(),
  );
}

/** Case-insensitive lookup; the first configured match for an entry wins. */
export function findContextWarning(
  config: ModelFallbackConfig,
  entry: ChainEntry,
): ContextWarning | undefined {
  return config.contextWarnings.find(
    (warning) =>
      warning.entry.provider.toLowerCase() === entry.provider.toLowerCase() &&
      warning.entry.id.toLowerCase() === entry.id.toLowerCase(),
  );
}

export function loadConfig(cwd: string): ModelFallbackConfig {
  const globalPath = join(resolveAgentDir(), "model-fallback.json");
  const projectPath = join(cwd, ".pi", "model-fallback.json");
  const raw = mergeRaw(readJson(globalPath), readJson(projectPath));
  return normalizeConfig(raw);
}
