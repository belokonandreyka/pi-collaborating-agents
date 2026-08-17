import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ModelFallbackConfig {
  enabled: boolean;
  orchestratorOnly: boolean;
  chain: ChainEntry[];
  resumeText: string;
  notifyUser: boolean;
  /**
   * Chain entries that cost real money. Switching onto one of these emits
   * `paidNoticeText` at "error" level so it renders red — the subscription
   * pools are gone at that point and every further turn is billed.
   */
  paidEntries: ChainEntry[];
  paidNoticeText: string;
}

export interface ChainEntry {
  provider: string;
  id: string;
}

export const DEFAULT_RESUME_TEXT =
  "The previous provider exhausted its quota. Continue the current task from where it stopped; do not redo completed work.";

export const DEFAULT_PAID_NOTICE_TEXT =
  "\u0412\u0421\u0406 \u041b\u0406\u041c\u0406\u0422\u0418 \u0412\u0418\u0427\u0415\u0420\u041f\u0410\u041d\u0406 \u2014 \u043f\u0440\u0430\u0446\u044e\u0454\u043c\u043e \u043d\u0430 \u043f\u043b\u0430\u0442\u043d\u0456\u0439 \u043e\u0441\u043d\u043e\u0432\u0456";

export const DEFAULT_CONFIG: ModelFallbackConfig = {
  enabled: false,
  orchestratorOnly: true,
  chain: [],
  resumeText: DEFAULT_RESUME_TEXT,
  notifyUser: true,
  paidEntries: [],
  paidNoticeText: DEFAULT_PAID_NOTICE_TEXT,
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
    notifyUser: typeof raw.notifyUser === "boolean" ? raw.notifyUser : DEFAULT_CONFIG.notifyUser,
    paidEntries: normalizeChain(raw.paidEntries),
    paidNoticeText:
      typeof raw.paidNoticeText === "string" && raw.paidNoticeText.trim().length > 0
        ? raw.paidNoticeText
        : DEFAULT_CONFIG.paidNoticeText,
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

export function loadConfig(cwd: string): ModelFallbackConfig {
  const globalPath = join(resolveAgentDir(), "model-fallback.json");
  const projectPath = join(cwd, ".pi", "model-fallback.json");
  const raw = mergeRaw(readJson(globalPath), readJson(projectPath));
  return normalizeConfig(raw);
}
