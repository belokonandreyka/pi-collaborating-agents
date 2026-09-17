import type * as fs from "node:fs";

export type DeliveryKind = "direct" | "broadcast";

export interface FileReservation {
  pattern: string;
  reason?: string;
  since: string;
}

export type AgentRole = "subagent" | "orchestrator";

export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  model: string;
  startedAt: string;
  lastSeenAt: string;
  role?: AgentRole;
  reservations?: FileReservation[];
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  kind: DeliveryKind;
  timestamp: string;
  urgent?: boolean;
  replyTo?: string | null;
}

export interface MessageLogEvent {
  id: string;
  from: string;
  to: string | "all";
  text: string;
  kind: DeliveryKind;
  timestamp: string;
  urgent?: boolean;
  recipients?: string[];
  replyTo?: string | null;
}

export interface ReservationConflict {
  path: string;
  agent: string;
  pattern: string;
  reason?: string;
  registration: AgentRegistration;
}

export type FocusState =
  | { mode: "local" }
  | {
      mode: "remote";
      targetAgent: string;
      targetSessionId: string;
    };

export interface Dirs {
  base: string;
  registry: string;
  inbox: string;
  messageLog: string;
  runs: string;
}

export interface ExtensionState {
  agentName: string;
  registered: boolean;
  focus: FocusState;
  reservations: FileReservation[];
  unreadCounts: Map<string, number>;
  watcher: fs.FSWatcher | null;
  watcherDebounceTimer: ReturnType<typeof setTimeout> | null;
  hasClearedSubagentHistory: boolean;
  hasSpawnedSubagents: boolean;
  completedSubagents: AgentRegistration[];
  activeSubagentRuns: number;
}

export type SubagentLaunchMode = "process" | "herdr-pane";

/**
 * Where a herdr-pane subagent goes: a split of the current tab, a new tab, or
 * `auto`, which picks a tab when the orchestrator's terminal is narrower than
 * `subagentTabBelowColumns` (a phone client at 50 columns split to 22 once and
 * crashed both sides).
 */
export type SubagentPanePlacement = "split" | "tab" | "auto";

export type SubagentCompletionDisplay = "full" | "hidden";

export type SubagentLaunchDisplay = "full" | "compact" | "hidden";

export type SubagentRunStatus = "launching" | "running" | "completed" | "failed";

export interface SubagentRunRecord {
  recordId: string;
  batchRunId: string;
  taskIndex: number;
  parentAgent: string;
  parentSessionId?: string;
  parentSessionFile?: string;
  parentPid?: number;
  name?: string;
  displayName?: string;
  type: string;
  taskPreview: string;
  requestedCwd?: string;
  cwd: string;
  status: SubagentRunStatus;
  sessionId?: string;
  sessionFile?: string;
  sessionFileUnavailableReason?: string;
  model?: string;
  launchMode: SubagentLaunchMode;
  /** Pane the child is running in; the address a reply is typed into. */
  paneRef?: string;
  /** Question the child stopped on, while it is still waiting for an answer. */
  awaitingReply?: string;
  startedAt: string;
  lastSeenAt: string;
  completedAt?: string;
  exitCode?: number;
  outputPreview?: string;
  warnings?: string[];
  sessionReadyNotifiedAt?: string;
}

export interface SubagentRunListRecord extends SubagentRunRecord {
  displayName?: string;
  isStale: boolean;
}

export interface SubagentRunResolutionContext {
  parentAgent: string;
  parentSessionId?: string;
  parentPid?: number;
  now?: Date | string | number;
  staleAfterMs?: number;
  candidateLimit?: number;
}

export type SubagentRunResolutionResult =
  | {
      status: "ok";
      record: SubagentRunListRecord;
    }
  | {
      status: "ambiguous";
      message: string;
      candidates: SubagentRunListRecord[];
    }
  | {
      status: "not_found";
      message: string;
      candidates: SubagentRunListRecord[];
    };

export interface CollaboratingAgentsConfig {
  messageHistoryLimit: number;
  subagentLaunchMode: SubagentLaunchMode;
  closeCompletedPanes: boolean;
  closeFailedPanes: boolean;
  preserveOrchestratorPane: boolean;
  /** Minimum gap between progress updates posted to the orchestrator, per child. 0 disables them. */
  subagentProgressIntervalMs: number;
  /** How many subagent batches may run at once (a resumed reply counts as one). 0 removes the cap. */
  maxConcurrentSubagentBatches: number;
  subagentCompletionDisplay: SubagentCompletionDisplay;
  triggerTurnOnSubagentCompletion: boolean;
  subagentLaunchDisplay: SubagentLaunchDisplay;
  subagentPanePlacement: SubagentPanePlacement;
  /** With `subagentPanePlacement: "auto"`, terminals narrower than this get a tab instead of a split. */
  subagentTabBelowColumns: number;
  /** Pi config directory (`PI_CODING_AGENT_DIR`) for spawned subagents. Unset = inherit the parent's. */
  subagentAgentDir?: string;
}

export type AgentMessageAction =
  | "status"
  | "list"
  | "sessions"
  | "session"
  | "tail"
  | "send"
  | "broadcast"
  | "feed"
  | "thread"
  | "reserve"
  | "release";

export interface RemoteTurnResult {
  assistantText: string;
  turnIndex?: number;
}

/**
 * Configuration for a subagent type loaded from TOML files.
 * These define specialized subagent profiles with specific prompts,
 * models, and reasoning levels.
 */
export interface SubagentTypeConfig {
  /** Unique identifier for this subagent type (e.g., "scout", "documenter") */
  name: string;
  /** Human-readable description of what this subagent type does */
  description: string;
  /** Optional model override (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4-20250514") */
  model?: string;
  /** Optional reasoning level (e.g., "low", "medium", "high", "xhigh") */
  reasoning?: "low" | "medium" | "high" | "xhigh";
  /**
   * Optional tool allow-list for this type, replacing the default set. Written
   * in the TOML as a comma-separated string (`tools = "read, bash, mcp"`),
   * because the simple parser reads every value as a string. A type that needs
   * a tool outside the default five — an MCP proxy, for instance — has no other
   * way to ask for it.
   */
  tools?: string[];
  /** The system prompt for this subagent type */
  prompt: string;
  /** Source of the configuration */
  source: "bundled" | "user" | "project";
  /** Path to the TOML file */
  filePath: string;
}
