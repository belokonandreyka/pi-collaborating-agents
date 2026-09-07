import { homedir } from "node:os";
import { join } from "node:path";
import type { Dirs } from "./types.js";

/**
 * Where this session's collaboration bus lives (registry, inboxes, message log, runs).
 *
 * Resolution order:
 * 1. `COLLABORATING_AGENTS_DIR` — explicit bus; spawned children receive the parent's
 *    bus this way so a child in a slimmer profile still shares its parent's registry.
 * 2. `PI_CODING_AGENT_DIR/collaborating-agents` — a standalone session in another Pi
 *    profile gets its own bus. Without this, a personal-profile session and a work
 *    orchestrator on the same machine share one registry, receive each other's
 *    broadcasts, and answer questions that were never addressed to them.
 * 3. `~/.pi/agent/collaborating-agents` — the default profile.
 */
export function resolveDirs(): Dirs {
  const explicit = process.env.COLLABORATING_AGENTS_DIR?.trim();
  const profileDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const base = explicit || join(profileDir || join(homedir(), ".pi", "agent"), "collaborating-agents");
  return {
    base,
    registry: join(base, "registry"),
    inbox: join(base, "inbox"),
    messageLog: join(base, "messages.jsonl"),
    runs: join(base, "runs"),
  };
}
