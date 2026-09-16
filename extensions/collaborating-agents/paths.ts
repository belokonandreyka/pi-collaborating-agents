import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
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
/**
 * The Pi profile directory this session belongs to — where `collaborating-agents.json`,
 * the agent-type definitions (`../agents`), `sessions/` and `tmp/` live.
 *
 * 1. the profile that owns the pinned bus (`<profile>/collaborating-agents`): a child launched
 *    into a slimmer profile keeps spawning with its parent's types and config. A bus that is
 *    not a profile's own (an explicit test dir, say) says nothing about the profile;
 * 2. `PI_CODING_AGENT_DIR` — a standalone session in another profile. Before this the
 *    personal profile read the work profile's types and launched its subagents on the
 *    work gateway (2026-09-09, six personal runs billed to the work account);
 * 3. `~/.pi/agent`.
 */
export function resolveProfileAgentDir(): string {
  const bus = process.env.COLLABORATING_AGENTS_DIR?.trim();
  if (bus && basename(bus) === "collaborating-agents") return dirname(bus);
  const profileDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (profileDir) return profileDir;
  return join(resolveHomeDir(), ".pi", "agent");
}

/** `$HOME` first: `os.homedir()` ignores a HOME set after startup, which the tests rely on. */
function resolveHomeDir(): string {
  const envHome = process.env.HOME?.trim();
  if (envHome) return envHome;
  const envUserProfile = process.env.USERPROFILE?.trim();
  if (envUserProfile) return envUserProfile;
  return homedir();
}

export function resolveDirs(): Dirs {
  const explicit = process.env.COLLABORATING_AGENTS_DIR?.trim();
  const profileDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const base = explicit || join(profileDir || join(resolveHomeDir(), ".pi", "agent"), "collaborating-agents");
  return {
    base,
    registry: join(base, "registry"),
    inbox: join(base, "inbox"),
    messageLog: join(base, "messages.jsonl"),
    runs: join(base, "runs"),
  };
}
