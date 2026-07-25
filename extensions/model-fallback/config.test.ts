import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, DEFAULT_RESUME_TEXT, loadConfig, parseChainEntry } from "./config.ts";

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
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
  if (typeof ORIGINAL_AGENT_DIR === "string") process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
  else delete process.env.PI_CODING_AGENT_DIR;
});

describe("parseChainEntry", () => {
  test("should split provider and id on the first slash only", () => {
    expect(parseChainEntry("openai-codex/gpt-5.6-sol")).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    });
    expect(parseChainEntry("anthropic/claude-opus-4-8")).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-8",
    });
  });

  test("should preserve slashes within the model id", () => {
    expect(parseChainEntry("proxy/team/model-1")).toEqual({
      provider: "proxy",
      id: "team/model-1",
    });
  });

  test("should reject entries without a provider or id", () => {
    expect(parseChainEntry("no-slash-here")).toBeNull();
    expect(parseChainEntry("/leading-slash")).toBeNull();
    expect(parseChainEntry("trailing-slash/")).toBeNull();
    expect(parseChainEntry("")).toBeNull();
    expect(parseChainEntry(42 as unknown)).toBeNull();
  });
});

describe("loadConfig", () => {
  test("should return defaults when no config files exist", () => {
    const home = makeTempDir("mf-config-home-default");
    setHome(home);
    const cwd = makeTempDir("mf-config-cwd-default");

    const config = loadConfig(cwd);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.resumeText).toBe(DEFAULT_RESUME_TEXT);
    expect(config.chain).toEqual([]);
  });

  test("should read the global config from PI_CODING_AGENT_DIR when set", () => {
    const home = makeTempDir("mf-config-home-agentdir");
    setHome(home);
    // The default profile's config must lose to the one the env var points at,
    // or a second Pi instance would inherit the first instance's chain.
    const defaultPath = path.join(home, ".pi", "agent", "model-fallback.json");
    fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
    fs.writeFileSync(
      defaultPath,
      JSON.stringify({ enabled: true, chain: ["github-copilot/claude-opus-4.7"] }),
    );

    const agentDir = makeTempDir("mf-config-agentdir");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    fs.writeFileSync(
      path.join(agentDir, "model-fallback.json"),
      JSON.stringify({ enabled: true, chain: ["openai-codex/gpt-5.6-sol"] }),
    );

    const config = loadConfig(makeTempDir("mf-config-cwd-agentdir"));
    expect(config.enabled).toBe(true);
    expect(config.chain).toEqual([{ provider: "openai-codex", id: "gpt-5.6-sol" }]);
  });

  test("should fall back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset", () => {
    const home = makeTempDir("mf-config-home-noagentdir");
    setHome(home);
    delete process.env.PI_CODING_AGENT_DIR;
    const defaultPath = path.join(home, ".pi", "agent", "model-fallback.json");
    fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
    fs.writeFileSync(
      defaultPath,
      JSON.stringify({ enabled: true, chain: ["github-copilot/claude-opus-4.7"] }),
    );

    const config = loadConfig(makeTempDir("mf-config-cwd-noagentdir"));
    expect(config.chain).toEqual([{ provider: "github-copilot", id: "claude-opus-4.7" }]);
  });

  test("should merge global and project configs with project taking precedence", () => {
    const home = makeTempDir("mf-config-home-merge");
    setHome(home);
    const globalPath = path.join(home, ".pi", "agent", "model-fallback.json");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({
        enabled: true,
        chain: ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.6-sol"],
        resumeText: "global resume",
        notifyUser: false,
      }),
      "utf-8",
    );

    const cwd = makeTempDir("mf-config-cwd-merge");
    const projectPath = path.join(cwd, ".pi", "model-fallback.json");
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({
        chain: ["github-copilot/claude-opus-4.7"],
        orchestratorOnly: false,
      }),
      "utf-8",
    );

    const config = loadConfig(cwd);
    expect(config.enabled).toBe(true);
    expect(config.notifyUser).toBe(false);
    expect(config.orchestratorOnly).toBe(false);
    expect(config.resumeText).toBe("global resume");
    expect(config.chain).toEqual([{ provider: "github-copilot", id: "claude-opus-4.7" }]);
  });

  test("should drop invalid chain entries and keep the valid ones", () => {
    const home = makeTempDir("mf-config-home-invalid-chain");
    setHome(home);
    const cwd = makeTempDir("mf-config-cwd-invalid-chain");
    const projectPath = path.join(cwd, ".pi", "model-fallback.json");
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({
        enabled: true,
        chain: [
          "anthropic/claude-opus-4-8",
          "no-slash",
          42,
          "/leading",
          "trailing/",
          "proxy/team/model-1",
        ],
      }),
      "utf-8",
    );

    const config = loadConfig(cwd);
    expect(config.chain).toEqual([
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "proxy", id: "team/model-1" },
    ]);
  });

  test("should ignore malformed json files and fall back to defaults", () => {
    const home = makeTempDir("mf-config-home-malformed");
    setHome(home);
    const globalPath = path.join(home, ".pi", "agent", "model-fallback.json");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, "{not-json", "utf-8");
    const cwd = makeTempDir("mf-config-cwd-malformed");

    const config = loadConfig(cwd);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  test("should keep default resume text when project supplies an empty string", () => {
    const home = makeTempDir("mf-config-home-empty-resume");
    setHome(home);
    const cwd = makeTempDir("mf-config-cwd-empty-resume");
    const projectPath = path.join(cwd, ".pi", "model-fallback.json");
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, JSON.stringify({ resumeText: "   " }), "utf-8");

    const config = loadConfig(cwd);
    expect(config.resumeText).toBe(DEFAULT_RESUME_TEXT);
  });
});
