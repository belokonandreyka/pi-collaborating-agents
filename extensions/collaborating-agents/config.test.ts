import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config.ts";

const tempDirs: string[] = [];
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

const DEFAULT_CONFIG = {
  messageHistoryLimit: 400,
  subagentLaunchMode: "process",
  closeCompletedPanes: true,
  closeFailedPanes: false,
  preserveOrchestratorPane: false,
  subagentProgressIntervalMs: 30_000,
  subagentCompletionDisplay: "full",
  triggerTurnOnSubagentCompletion: false,
  subagentLaunchDisplay: "full",
};

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
});

describe("config loading", () => {
  test("uses defaults when no config files exist", () => {
    const home = makeTempDir("collab-config-home-default");
    setHome(home);

    const cwd = makeTempDir("collab-config-cwd-default");
    expect(loadConfig(cwd)).toEqual(DEFAULT_CONFIG);
  });

  test("closeFailedPanes can be turned on from config", () => {
    const home = makeTempDir("collab-config-home-failed-panes");
    setHome(home);

    const globalConfigPath = path.join(home, ".pi", "agent", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({ closeFailedPanes: true }), "utf-8");

    const config = loadConfig(makeTempDir("collab-config-cwd-failed-panes"));

    expect(config.closeFailedPanes).toBe(true);
    // Turning it on must not disturb the completed-pane behaviour.
    expect(config.closeCompletedPanes).toBe(true);
  });

  test("merges global and project configs with project taking precedence", () => {
    const home = makeTempDir("collab-config-home-merge");
    setHome(home);

    const globalConfigPath = path.join(home, ".pi", "agent", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(
      globalConfigPath,
      JSON.stringify({ messageHistoryLimit: 250, subagentCompletionDisplay: "full" }),
      "utf-8",
    );

    const cwd = makeTempDir("collab-config-cwd-merge");
    const projectConfigPath = path.join(cwd, ".pi", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify({
        messageHistoryLimit: 75,
        subagentLaunchMode: "herdr-pane",
        closeCompletedPanes: false,
        preserveOrchestratorPane: true,
        subagentProgressIntervalMs: 5_000,
        subagentCompletionDisplay: "hidden",
        triggerTurnOnSubagentCompletion: true,
        subagentLaunchDisplay: "compact",
      }),
      "utf-8",
    );

    expect(loadConfig(cwd)).toEqual({
      messageHistoryLimit: 75,
      subagentLaunchMode: "herdr-pane",
      closeCompletedPanes: false,
      closeFailedPanes: false,
      preserveOrchestratorPane: true,
      subagentProgressIntervalMs: 5_000,
      subagentCompletionDisplay: "hidden",
      triggerTurnOnSubagentCompletion: true,
      subagentLaunchDisplay: "compact",
    });
  });

  test("accepts herdr-pane as a launch mode", () => {
    const home = makeTempDir("collab-config-home-herdr");
    setHome(home);

    const cwd = makeTempDir("collab-config-cwd-herdr");
    const projectConfigPath = path.join(cwd, ".pi", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, JSON.stringify({ subagentLaunchMode: "herdr-pane" }), "utf-8");

    expect(loadConfig(cwd).subagentLaunchMode).toBe("herdr-pane");
  });

  test("falls back to defaults when config content is malformed or invalid", () => {
    const home = makeTempDir("collab-config-home-invalid");
    setHome(home);

    const globalConfigPath = path.join(home, ".pi", "agent", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(globalConfigPath), { recursive: true });
    fs.writeFileSync(globalConfigPath, "{not-json", "utf-8");

    const cwd = makeTempDir("collab-config-cwd-invalid");
    const projectConfigPath = path.join(cwd, ".pi", "collaborating-agents.json");
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(
      projectConfigPath,
      JSON.stringify({
        messageHistoryLimit: 0,
        subagentLaunchMode: "cmux-window",
        preserveOrchestratorPane: "yes",
        subagentProgressIntervalMs: -1,
        subagentCompletionDisplay: "summary",
        triggerTurnOnSubagentCompletion: "yes",
        subagentLaunchDisplay: "verbose",
      }),
      "utf-8",
    );

    expect(loadConfig(cwd)).toEqual(DEFAULT_CONFIG);
  });
});
