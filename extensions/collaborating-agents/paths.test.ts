import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { homedir } from "node:os";
import * as path from "node:path";
import { resolveDirs } from "./paths.ts";

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_COLLAB_DIR = process.env.COLLABORATING_AGENTS_DIR;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function setHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof ORIGINAL_HOME === "string") process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;

  if (typeof ORIGINAL_USERPROFILE === "string") process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  else delete process.env.USERPROFILE;

  if (typeof ORIGINAL_COLLAB_DIR === "string") process.env.COLLABORATING_AGENTS_DIR = ORIGINAL_COLLAB_DIR;
  else delete process.env.COLLABORATING_AGENTS_DIR;

  if (typeof ORIGINAL_AGENT_DIR === "string") process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  else delete process.env.PI_CODING_AGENT_DIR;
});

describe("path resolution", () => {
  test("uses default path under home directory when override is absent", () => {
    delete process.env.COLLABORATING_AGENTS_DIR;
    delete process.env.PI_CODING_AGENT_DIR;

    const dirs = resolveDirs();
    const expectedBase = path.join(homedir(), ".pi", "agent", "collaborating-agents");

    expect(dirs).toEqual({
      base: expectedBase,
      registry: path.join(expectedBase, "registry"),
      inbox: path.join(expectedBase, "inbox"),
      messageLog: path.join(expectedBase, "messages.jsonl"),
      runs: path.join(expectedBase, "runs"),
    });
  });

  test("a session in another Pi profile gets that profile's own bus", () => {
    delete process.env.COLLABORATING_AGENTS_DIR;
    const profile = makeTempDir("collab-paths-profile");
    process.env.PI_CODING_AGENT_DIR = profile;

    // Two profiles on one machine used to share ~/.pi/agent's registry, so a
    // personal session received a work orchestrator's broadcasts and answered them.
    expect(resolveDirs().base).toBe(path.join(profile, "collaborating-agents"));
  });

  test("an explicit bus outranks the profile directory", () => {
    const profile = makeTempDir("collab-paths-profile-explicit");
    const bus = makeTempDir("collab-paths-bus");
    process.env.PI_CODING_AGENT_DIR = profile;
    process.env.COLLABORATING_AGENTS_DIR = bus;

    expect(resolveDirs().base).toBe(bus);
  });

  test("uses COLLABORATING_AGENTS_DIR when provided", () => {
    const home = makeTempDir("collab-paths-home-override");
    setHome(home);

    const overrideBase = path.join(home, "custom-collab-state");
    process.env.COLLABORATING_AGENTS_DIR = overrideBase;

    const dirs = resolveDirs();

    expect(dirs).toEqual({
      base: overrideBase,
      registry: path.join(overrideBase, "registry"),
      inbox: path.join(overrideBase, "inbox"),
      messageLog: path.join(overrideBase, "messages.jsonl"),
      runs: path.join(overrideBase, "runs"),
    });
  });
});

describe("resolveProfileAgentDir", () => {
  const { resolveProfileAgentDir } = require("./paths.ts") as typeof import("./paths.ts");

  function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      run();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("defaults to ~/.pi/agent", () => {
    const home = makeTempDir("profile-home");
    setHome(home);
    withEnv({ COLLABORATING_AGENTS_DIR: undefined, PI_CODING_AGENT_DIR: undefined }, () => {
      expect(resolveProfileAgentDir()).toBe(path.join(home, ".pi", "agent"));
    });
  });

  test("a standalone session in another profile uses PI_CODING_AGENT_DIR", () => {
    withEnv({ COLLABORATING_AGENTS_DIR: undefined, PI_CODING_AGENT_DIR: "/tmp/pi-personal/agent" }, () => {
      expect(resolveProfileAgentDir()).toBe("/tmp/pi-personal/agent");
    });
  });

  test("an explicit bus outside any profile does not pick the profile", () => {
    withEnv({ COLLABORATING_AGENTS_DIR: "/tmp/some-test-state", PI_CODING_AGENT_DIR: "/tmp/pi-personal/agent" }, () => {
      expect(resolveProfileAgentDir()).toBe("/tmp/pi-personal/agent");
    });
  });

  test("a child pinned to its parent's bus keeps the parent's profile", () => {
    withEnv(
      { COLLABORATING_AGENTS_DIR: "/tmp/pi-work/agent/collaborating-agents", PI_CODING_AGENT_DIR: "/tmp/pi-sub/agent" },
      () => {
        expect(resolveProfileAgentDir()).toBe("/tmp/pi-work/agent");
      },
    );
  });
});
