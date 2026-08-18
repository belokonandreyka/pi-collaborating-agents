import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CollaboratingAgentsConfig,
  SubagentCompletionDisplay,
  SubagentLaunchDisplay,
  SubagentLaunchMode,
} from "./types.js";

const DEFAULT_CONFIG: CollaboratingAgentsConfig = {
  messageHistoryLimit: 400,
  subagentLaunchMode: "process",
  closeCompletedCmuxPanes: true,
  // Off by default: a failed pane is kept on screen so the failure can be read
  // where it happened. Turn on when retries matter more than post-mortems.
  closeFailedCmuxPanes: false,
  preserveOrchestratorPane: false,
  subagentProgressIntervalMs: 30_000,
  subagentCompletionDisplay: "full",
  triggerTurnOnSubagentCompletion: false,
  subagentLaunchDisplay: "full",
};

function isSubagentLaunchMode(value: unknown): value is SubagentLaunchMode {
  return value === "process" || value === "cmux-pane" || value === "herdr-pane";
}

function isSubagentCompletionDisplay(value: unknown): value is SubagentCompletionDisplay {
  return value === "full" || value === "hidden";
}

function isSubagentLaunchDisplay(value: unknown): value is SubagentLaunchDisplay {
  return value === "full" || value === "compact" || value === "hidden";
}

function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;

  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;

  return homedir();
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

export function loadConfig(cwd: string): CollaboratingAgentsConfig {
  const projectPath = join(cwd, ".pi", "collaborating-agents.json");
  const globalPath = join(resolveHomeDir(), ".pi", "agent", "collaborating-agents.json");

  const globalConfig = readJson(globalPath) as Partial<CollaboratingAgentsConfig> | null;
  const projectConfig = readJson(projectPath) as Partial<CollaboratingAgentsConfig> | null;

  const merged: Partial<CollaboratingAgentsConfig> = {
    ...DEFAULT_CONFIG,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {}),
  };

  return {
    messageHistoryLimit:
      typeof merged.messageHistoryLimit === "number" && merged.messageHistoryLimit > 0
        ? merged.messageHistoryLimit
        : DEFAULT_CONFIG.messageHistoryLimit,
    subagentLaunchMode: isSubagentLaunchMode(merged.subagentLaunchMode)
      ? merged.subagentLaunchMode
      : DEFAULT_CONFIG.subagentLaunchMode,
    closeCompletedCmuxPanes:
      typeof merged.closeCompletedCmuxPanes === "boolean"
        ? merged.closeCompletedCmuxPanes
        : DEFAULT_CONFIG.closeCompletedCmuxPanes,
    closeFailedCmuxPanes:
      typeof merged.closeFailedCmuxPanes === "boolean"
        ? merged.closeFailedCmuxPanes
        : DEFAULT_CONFIG.closeFailedCmuxPanes,
    preserveOrchestratorPane:
      typeof merged.preserveOrchestratorPane === "boolean"
        ? merged.preserveOrchestratorPane
        : DEFAULT_CONFIG.preserveOrchestratorPane,
    subagentProgressIntervalMs:
      typeof merged.subagentProgressIntervalMs === "number" && merged.subagentProgressIntervalMs >= 0
        ? merged.subagentProgressIntervalMs
        : DEFAULT_CONFIG.subagentProgressIntervalMs,
    subagentCompletionDisplay: isSubagentCompletionDisplay(merged.subagentCompletionDisplay)
      ? merged.subagentCompletionDisplay
      : DEFAULT_CONFIG.subagentCompletionDisplay,
    triggerTurnOnSubagentCompletion:
      typeof merged.triggerTurnOnSubagentCompletion === "boolean"
        ? merged.triggerTurnOnSubagentCompletion
        : DEFAULT_CONFIG.triggerTurnOnSubagentCompletion,
    subagentLaunchDisplay: isSubagentLaunchDisplay(merged.subagentLaunchDisplay)
      ? merged.subagentLaunchDisplay
      : DEFAULT_CONFIG.subagentLaunchDisplay,
  };
}
