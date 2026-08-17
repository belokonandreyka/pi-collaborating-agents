import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_CONFIG,
  DEFAULT_CONTEXT_WARNING_TEXT,
  DEFAULT_PAID_NOTICE_TEXT,
  DEFAULT_RESUME_TEXT,
  findContextWarning,
  isPaidEntry,
  loadConfig,
  normalizeConfig,
  parseChainEntry,
} from "./config.ts";

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

  test("should parse paidEntries with the same rules as chain", () => {
    const home = makeTempDir("mf-config-home-paid");
    setHome(home);
    const globalPath = path.join(home, ".pi", "agent", "model-fallback.json");
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({
        paidEntries: ["openrouter/google/gemini-3.7-flash", "", "no-slash", 42],
      }),
      "utf-8",
    );
    const cwd = makeTempDir("mf-config-cwd-paid");

    const config = loadConfig(cwd);
    // Provider is split on the FIRST slash, so the OpenRouter vendor prefix
    // stays part of the model id; malformed entries are dropped.
    expect(config.paidEntries).toEqual([
      { provider: "openrouter", id: "google/gemini-3.7-flash" },
    ]);
  });

  test("should default paidEntries to empty and keep the default paid notice", () => {
    const home = makeTempDir("mf-config-home-paid-default");
    setHome(home);
    const cwd = makeTempDir("mf-config-cwd-paid-default");

    const config = loadConfig(cwd);
    expect(config.paidEntries).toEqual([]);
    expect(config.paidNoticeText).toBe(DEFAULT_PAID_NOTICE_TEXT);
  });

  test("should keep default paid notice when project supplies a blank string", () => {
    const home = makeTempDir("mf-config-home-blank-notice");
    setHome(home);
    const cwd = makeTempDir("mf-config-cwd-blank-notice");
    const projectPath = path.join(cwd, ".pi", "model-fallback.json");
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, JSON.stringify({ paidNoticeText: "   " }), "utf-8");

    const config = loadConfig(cwd);
    expect(config.paidNoticeText).toBe(DEFAULT_PAID_NOTICE_TEXT);
  });

  test("isPaidEntry should match case-insensitively and reject non-members", () => {
    const config = normalizeConfig({
      paidEntries: ["OpenRouter/Google/Gemini-3.7-Flash"],
    });

    expect(isPaidEntry(config, { provider: "openrouter", id: "google/gemini-3.7-flash" })).toBe(
      true,
    );
    expect(isPaidEntry(config, { provider: "openai-codex", id: "gpt-5.6-sol" })).toBe(false);
  });

  test("should default contextWarnings to an empty array", () => {
    const home = makeTempDir("mf-config-home-ctxwarn-default");
    setHome(home);
    const cwd = makeTempDir("mf-config-cwd-ctxwarn-default");

    expect(loadConfig(cwd).contextWarnings).toEqual([]);
  });

  test("should parse contextWarnings and keep a custom text", () => {
    const config = normalizeConfig({
      contextWarnings: [
        { entry: "openai-codex/gpt-5.6-sol", aboveTokens: 270000 },
        { entry: "openrouter/google/gemini-3.7-flash", aboveTokens: 900000, text: "careful" },
      ],
    });

    expect(config.contextWarnings).toEqual([
      {
        entry: { provider: "openai-codex", id: "gpt-5.6-sol" },
        aboveTokens: 270000,
        text: DEFAULT_CONTEXT_WARNING_TEXT,
      },
      {
        entry: { provider: "openrouter", id: "google/gemini-3.7-flash" },
        aboveTokens: 900000,
        text: "careful",
      },
    ]);
  });

  test("should fall back to the default text when contextWarnings text is blank", () => {
    const config = normalizeConfig({
      contextWarnings: [{ entry: "openai-codex/gpt-5.6-sol", aboveTokens: 1, text: "   " }],
    });

    expect(config.contextWarnings[0]!.text).toBe(DEFAULT_CONTEXT_WARNING_TEXT);
  });

  test("should drop malformed contextWarnings items and keep the valid ones", () => {
    const config = normalizeConfig({
      contextWarnings: [
        { entry: "no-slash", aboveTokens: 100 },
        { entry: "openai-codex/gpt-5.6-sol" },
        { entry: "openai-codex/gpt-5.6-sol", aboveTokens: 0 },
        { entry: "openai-codex/gpt-5.6-sol", aboveTokens: -5 },
        { entry: "openai-codex/gpt-5.6-sol", aboveTokens: Number.NaN },
        { entry: "openai-codex/gpt-5.6-sol", aboveTokens: "270000" },
        { aboveTokens: 100 },
        "not-an-object",
        null,
        { entry: "anthropic/claude-opus-4-8", aboveTokens: 150000 },
      ],
    });

    expect(config.contextWarnings).toEqual([
      {
        entry: { provider: "anthropic", id: "claude-opus-4-8" },
        aboveTokens: 150000,
        text: DEFAULT_CONTEXT_WARNING_TEXT,
      },
    ]);
  });

  test("should ignore a non-array contextWarnings value", () => {
    expect(normalizeConfig({ contextWarnings: { entry: "a/b", aboveTokens: 1 } }).contextWarnings)
      .toEqual([]);
  });

  test("findContextWarning should match case-insensitively, keep slash-bearing ids, and miss cleanly", () => {
    const config = normalizeConfig({
      contextWarnings: [
        { entry: "OpenRouter/Google/Gemini-3.7-Flash", aboveTokens: 900000, text: "first" },
        { entry: "openrouter/google/gemini-3.7-flash", aboveTokens: 100, text: "second" },
      ],
    });

    const hit = findContextWarning(config, {
      provider: "OPENROUTER",
      id: "google/GEMINI-3.7-flash",
    });
    // First configured match wins even when a later item also matches.
    expect(hit?.text).toBe("first");
    expect(findContextWarning(config, { provider: "openai-codex", id: "gpt-5.6-sol" })).toBeUndefined();
  });
});
