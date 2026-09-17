import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SpawnAgentDefinition } from "./subagent-spawn.ts";
import {
  collectInheritedPaneEnv,
  buildPaneCommand,
  discoverSpawnAgents,
  resolvePaneEnvFile,
  resolveSubagentSessionsDir,
  mapWithConcurrencyLimit,
  resetPaneLayoutStateForTests,
  resolveSpawnAgentDefinition,
  replyToSubagent,
  startReplyToSubagent,
  runSpawnTask,
  waitForSettledSessionResult,
} from "./subagent-spawn.ts";

const tempDirs: string[] = [];
const ORIGINAL_TEST_HERDR_ARGS_FILE = process.env.TEST_HERDR_ARGS_FILE;
const ORIGINAL_TEST_HERDR_SEND_ASYNC = process.env.TEST_HERDR_SEND_ASYNC;
const ORIGINAL_TEST_HERDR_FAIL_SPLIT_PANE = process.env.TEST_HERDR_FAIL_SPLIT_PANE;
const ORIGINAL_TEST_HERDR_CLOSE_FAIL = process.env.TEST_HERDR_CLOSE_FAIL;
const ORIGINAL_HERDR_ENV = process.env.HERDR_ENV;
const ORIGINAL_HERDR_PANE_ID = process.env.HERDR_PANE_ID;

function restoreEnv(name: string, original: string | undefined): void {
  if (typeof original === "string") {
    process.env[name] = original;
  } else {
    delete process.env[name];
  }
}

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_TEST_ARGS_FILE = process.env.TEST_ARGS_FILE;
const ORIGINAL_TEST_PI_EXIT_DELAY_MS = process.env.TEST_PI_EXIT_DELAY_MS;
const ORIGINAL_TEST_PI_SESSION_CREATE_DELAY_MS = process.env.TEST_PI_SESSION_CREATE_DELAY_MS;
const ORIGINAL_TEST_PI_PROCESS_MESSAGE_EVENT = process.env.TEST_PI_PROCESS_MESSAGE_EVENT;
const ORIGINAL_TEST_PI_SESSION_MESSAGE_END_EVENT = process.env.TEST_PI_SESSION_MESSAGE_END_EVENT;
const ORIGINAL_TEST_PI_PROCESS_STDERR = process.env.TEST_PI_PROCESS_STDERR;
const ORIGINAL_TEST_PI_PROCESS_EXIT_CODE = process.env.TEST_PI_PROCESS_EXIT_CODE;
const ORIGINAL_TEST_PI_EXIT_CODE = process.env.TEST_PI_EXIT_CODE;
const ORIGINAL_TEST_PI_MULTI_TURN = process.env.TEST_PI_MULTI_TURN;
const ORIGINAL_TEST_PI_SAME_MTIME_FINAL_ONLY = process.env.TEST_PI_SAME_MTIME_FINAL_ONLY;
const ORIGINAL_TEST_PI_ASSISTANT_ERROR = process.env.TEST_PI_ASSISTANT_ERROR;
const ORIGINAL_TEST_PI_ASSISTANT_ERROR_THEN_FINAL = process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL;
const ORIGINAL_TEST_PI_REGISTER_SELF = process.env.TEST_PI_REGISTER_SELF;
const ORIGINAL_TEST_PI_REGISTER_SESSION_FILE = process.env.TEST_PI_REGISTER_SESSION_FILE;
const ORIGINAL_COLLABORATING_AGENTS_DIR = process.env.COLLABORATING_AGENTS_DIR;
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function setHome(homeDir: string): void {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
}

function writeAgentMarkdown(
  dir: string,
  fileName: string,
  options: {
    name?: string;
    description?: string;
    model?: string;
    tools?: string;
    promptBody?: string;
  },
): string {
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = [
    "---",
    options.name ? `name: ${options.name}` : undefined,
    options.description ? `description: ${options.description}` : undefined,
    options.model ? `model: ${options.model}` : undefined,
    options.tools ? `tools: ${options.tools}` : undefined,
    "---",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  const content = `${frontmatter}\n\n${options.promptBody ?? "Agent prompt"}\n`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function writeFakePiBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "pi");
  const argsFile = path.join(dir, "captured-args.json");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const argsFile = process.env.TEST_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(args), "utf-8");
}
const envFile = process.env.TEST_ENV_FILE;
if (envFile) {
  fs.writeFileSync(envFile, JSON.stringify({ PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null, COLLABORATING_AGENTS_DIR: process.env.COLLABORATING_AGENTS_DIR ?? null }), "utf-8");
}

const sessionIndex = args.indexOf("--session");
const sessionPath = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;

if (process.env.TEST_PI_REGISTER_SELF === "1" && process.env.COLLABORATING_AGENTS_DIR && process.env.PI_AGENT_NAME) {
  const registryDir = path.join(process.env.COLLABORATING_AGENTS_DIR, "registry");
  fs.mkdirSync(registryDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(registryDir, process.env.PI_AGENT_NAME + ".json"), JSON.stringify({
    name: process.env.PI_AGENT_NAME,
    pid: process.pid,
    sessionId: "fake-session",
    sessionFile: process.env.TEST_PI_REGISTER_SESSION_FILE,
    cwd: process.cwd(),
    model: "fake/model",
    startedAt: now,
    lastSeenAt: now,
    role: "subagent",
  }), "utf-8");
}

if (args.includes("--mode") && args.includes("json")) {
  process.stdout.write(JSON.stringify({ type: "session", id: "fake-session" }) + "\\n");
  if (process.env.TEST_PI_ASSISTANT_ERROR === "1" || process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL === "1") {
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "fetch failed",
      },
    }) + "\\n");
  }
  if (process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL === "1") {
    process.stdout.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fake-final-after-error" }],
        stopReason: "stop",
      },
    }) + "\\n");
  } else if (process.env.TEST_PI_ASSISTANT_ERROR !== "1") {
    const processMessageType = process.env.TEST_PI_PROCESS_MESSAGE_EVENT === "1" ? "message" : "message_end";
    process.stdout.write(JSON.stringify({
      type: processMessageType,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fake-ok" }],
        ...(processMessageType === "message" ? { stopReason: "stop" } : {}),
      },
    }) + "\\n");
  }
  const processStderr = process.env.TEST_PI_PROCESS_STDERR;
  if (processStderr) {
    process.stderr.write(processStderr);
  }
  const processExitCode = Number(process.env.TEST_PI_PROCESS_EXIT_CODE || "0");
  process.exit(processExitCode);
}

if (sessionPath) {
  const writeSession = () => {
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "fake-session" }) + "\\n", "utf-8");
    const initialSessionMtime = fs.statSync(sessionPath).mtime;

    const appendSessionLine = (payload, preserveInitialMtime = false) => {
      fs.appendFileSync(sessionPath, JSON.stringify(payload) + "\\n", "utf-8");
      if (preserveInitialMtime) {
        fs.utimesSync(sessionPath, initialSessionMtime, initialSessionMtime);
      }
    };

    if (process.env.TEST_PI_SAME_MTIME_FINAL_ONLY === "1") {
      setTimeout(() => {
        appendSessionLine({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fake-ok" }],
            stopReason: "stop",
          },
        }, true);
      }, 120);
    } else if (process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL === "1") {
      appendSessionLine({
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fetch failed",
        },
      });

      setTimeout(() => {
        appendSessionLine({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fake-final-after-error" }],
            stopReason: "stop",
          },
        });
      }, 1500);
    } else if (process.env.TEST_PI_ASSISTANT_ERROR === "1") {
      appendSessionLine({
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fetch failed",
        },
      });
    } else if (process.env.TEST_PI_MULTI_TURN === "1") {
      setTimeout(() => {
        appendSessionLine({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fake-intermediate" }],
            stopReason: "stop",
          },
        });
      }, 20);

      setTimeout(() => {
        appendSessionLine({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } }],
            stopReason: "toolUse",
          },
        });
      }, 220);

      setTimeout(() => {
        appendSessionLine({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "ok" }],
          },
        });
      }, 420);

      setTimeout(() => {
        appendSessionLine({
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fake-final" }],
            stopReason: "stop",
          },
        });
      }, 620);
    } else {
      const sessionMessageType = process.env.TEST_PI_SESSION_MESSAGE_END_EVENT === "1" ? "message_end" : "message";
      appendSessionLine({
        type: sessionMessageType,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "fake-ok" }],
          ...(sessionMessageType === "message" ? { stopReason: "stop" } : {}),
        },
      });
    }
  };

  const sessionCreateDelayMs = Number(process.env.TEST_PI_SESSION_CREATE_DELAY_MS || "0");
  if (Number.isFinite(sessionCreateDelayMs) && sessionCreateDelayMs > 0) {
    setTimeout(writeSession, sessionCreateDelayMs);
  } else {
    writeSession();
  }
}

const delayMs = Number(process.env.TEST_PI_EXIT_DELAY_MS || "0");
const exitCode = Number(process.env.TEST_PI_EXIT_CODE || "0");
const finish = () => {
  process.stdout.write("fake-text-mode\\n");
  process.exit(exitCode);
};

if (delayMs > 0) {
  setTimeout(finish, delayMs);
} else {
  finish();
}
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

function writeFailingFakePiBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "pi");
  const argsFile = path.join(dir, "captured-args.json");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");

const argsFile = process.env.TEST_ARGS_FILE;
if (argsFile) {
  fs.writeFileSync(argsFile, JSON.stringify(process.argv.slice(2)), "utf-8");
}

process.stderr.write("subagent crashed");
process.exit(2);
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

function readFakeHerdrState(argsFile: string): { nextPane: number; panes: string[]; pending: Record<string, string> } {
  return JSON.parse(fs.readFileSync(`${argsFile}.state.json`, "utf-8"));
}

function writeFakeHerdrState(
  argsFile: string,
  state: { nextPane: number; panes: string[]; pending: Record<string, string> },
): void {
  fs.writeFileSync(`${argsFile}.state.json`, JSON.stringify(state), "utf-8");
}

// Every test gets a throwaway HOME: the spawn path resolves the profile from
// HOME, and tests that never called setHome() wrote their session files into
// the real ~/.pi/agent/sessions/collaborating-agents-subagents (2,300 files
// between 2026-07-18 and 2026-09-17).
beforeEach(() => {
  setHome(makeTempDir("collab-home"));
});

afterEach(() => {
  resetPaneLayoutStateForTests();

  restoreEnv("TEST_HERDR_ARGS_FILE", ORIGINAL_TEST_HERDR_ARGS_FILE);
  restoreEnv("TEST_HERDR_SEND_ASYNC", ORIGINAL_TEST_HERDR_SEND_ASYNC);
  restoreEnv("TEST_HERDR_FAIL_SPLIT_PANE", ORIGINAL_TEST_HERDR_FAIL_SPLIT_PANE);
  restoreEnv("TEST_HERDR_CLOSE_FAIL", ORIGINAL_TEST_HERDR_CLOSE_FAIL);
  restoreEnv("HERDR_ENV", ORIGINAL_HERDR_ENV);
  restoreEnv("HERDR_PANE_ID", ORIGINAL_HERDR_PANE_ID);

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (typeof ORIGINAL_PATH === "string") {
    process.env.PATH = ORIGINAL_PATH;
  } else {
    delete process.env.PATH;
  }

  if (typeof ORIGINAL_TEST_ARGS_FILE === "string") {
    process.env.TEST_ARGS_FILE = ORIGINAL_TEST_ARGS_FILE;
  } else {
    delete process.env.TEST_ARGS_FILE;
  }




  if (typeof ORIGINAL_TEST_PI_EXIT_DELAY_MS === "string") {
    process.env.TEST_PI_EXIT_DELAY_MS = ORIGINAL_TEST_PI_EXIT_DELAY_MS;
  } else {
    delete process.env.TEST_PI_EXIT_DELAY_MS;
  }

  if (typeof ORIGINAL_TEST_PI_SESSION_CREATE_DELAY_MS === "string") {
    process.env.TEST_PI_SESSION_CREATE_DELAY_MS = ORIGINAL_TEST_PI_SESSION_CREATE_DELAY_MS;
  } else {
    delete process.env.TEST_PI_SESSION_CREATE_DELAY_MS;
  }

  if (typeof ORIGINAL_TEST_PI_PROCESS_MESSAGE_EVENT === "string") {
    process.env.TEST_PI_PROCESS_MESSAGE_EVENT = ORIGINAL_TEST_PI_PROCESS_MESSAGE_EVENT;
  } else {
    delete process.env.TEST_PI_PROCESS_MESSAGE_EVENT;
  }

  if (typeof ORIGINAL_TEST_PI_SESSION_MESSAGE_END_EVENT === "string") {
    process.env.TEST_PI_SESSION_MESSAGE_END_EVENT = ORIGINAL_TEST_PI_SESSION_MESSAGE_END_EVENT;
  } else {
    delete process.env.TEST_PI_SESSION_MESSAGE_END_EVENT;
  }

  if (typeof ORIGINAL_TEST_PI_PROCESS_STDERR === "string") {
    process.env.TEST_PI_PROCESS_STDERR = ORIGINAL_TEST_PI_PROCESS_STDERR;
  } else {
    delete process.env.TEST_PI_PROCESS_STDERR;
  }

  if (typeof ORIGINAL_TEST_PI_PROCESS_EXIT_CODE === "string") {
    process.env.TEST_PI_PROCESS_EXIT_CODE = ORIGINAL_TEST_PI_PROCESS_EXIT_CODE;
  } else {
    delete process.env.TEST_PI_PROCESS_EXIT_CODE;
  }



  if (typeof ORIGINAL_TEST_PI_EXIT_CODE === "string") {
    process.env.TEST_PI_EXIT_CODE = ORIGINAL_TEST_PI_EXIT_CODE;
  } else {
    delete process.env.TEST_PI_EXIT_CODE;
  }

  if (typeof ORIGINAL_TEST_PI_MULTI_TURN === "string") {
    process.env.TEST_PI_MULTI_TURN = ORIGINAL_TEST_PI_MULTI_TURN;
  } else {
    delete process.env.TEST_PI_MULTI_TURN;
  }

  if (typeof ORIGINAL_TEST_PI_SAME_MTIME_FINAL_ONLY === "string") {
    process.env.TEST_PI_SAME_MTIME_FINAL_ONLY = ORIGINAL_TEST_PI_SAME_MTIME_FINAL_ONLY;
  } else {
    delete process.env.TEST_PI_SAME_MTIME_FINAL_ONLY;
  }

  if (typeof ORIGINAL_TEST_PI_ASSISTANT_ERROR === "string") {
    process.env.TEST_PI_ASSISTANT_ERROR = ORIGINAL_TEST_PI_ASSISTANT_ERROR;
  } else {
    delete process.env.TEST_PI_ASSISTANT_ERROR;
  }

  if (typeof ORIGINAL_TEST_PI_ASSISTANT_ERROR_THEN_FINAL === "string") {
    process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL = ORIGINAL_TEST_PI_ASSISTANT_ERROR_THEN_FINAL;
  } else {
    delete process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL;
  }

  if (typeof ORIGINAL_TEST_PI_REGISTER_SELF === "string") {
    process.env.TEST_PI_REGISTER_SELF = ORIGINAL_TEST_PI_REGISTER_SELF;
  } else {
    delete process.env.TEST_PI_REGISTER_SELF;
  }

  if (typeof ORIGINAL_TEST_PI_REGISTER_SESSION_FILE === "string") {
    process.env.TEST_PI_REGISTER_SESSION_FILE = ORIGINAL_TEST_PI_REGISTER_SESSION_FILE;
  } else {
    delete process.env.TEST_PI_REGISTER_SESSION_FILE;
  }

  if (typeof ORIGINAL_COLLABORATING_AGENTS_DIR === "string") {
    process.env.COLLABORATING_AGENTS_DIR = ORIGINAL_COLLABORATING_AGENTS_DIR;
  } else {
    delete process.env.COLLABORATING_AGENTS_DIR;
  }

  if (typeof ORIGINAL_HOME === "string") {
    process.env.HOME = ORIGINAL_HOME;
  } else {
    delete process.env.HOME;
  }

  if (typeof ORIGINAL_USERPROFILE === "string") {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  } else {
    delete process.env.USERPROFILE;
  }
});

describe("settled session result", () => {
  function writeErrorSession(dir: string): string {
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s-1", timestamp: "2026-08-18T15:52:26.000Z" }),
        JSON.stringify({
          type: "message",
          id: "m-1",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Codex error: The usage limit has been reached",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    return sessionFile;
  }

  test("settles on a terminal error even when the child never writes an exit marker", async () => {
    const tempDir = makeTempDir("collab-settle-error");
    const sessionFile = writeErrorSession(tempDir);

    const startedAt = Date.now();
    const result = await waitForSettledSessionResult({
      sessionFile,
      exitMarkerPath: path.join(tempDir, "missing.exit"),
      timeoutMs: 30_000,
      idleGraceMs: 100,
      errorSettleMs: 200,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.terminalError).toBe("Error: Codex error: The usage limit has been reached");
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    // Without the bounded error-settle window this parked on the full 30s
    // inactivity budget instead of reporting the failure.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("an exit marker still short-circuits the error settle window", async () => {
    const tempDir = makeTempDir("collab-settle-error-marker");
    const sessionFile = writeErrorSession(tempDir);
    const exitMarkerPath = path.join(tempDir, "run.exit");
    fs.writeFileSync(exitMarkerPath, "1\n", "utf-8");

    const result = await waitForSettledSessionResult({
      sessionFile,
      exitMarkerPath,
      timeoutMs: 30_000,
      idleGraceMs: 100,
      errorSettleMs: 60_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.terminalError).toBe("Error: Codex error: The usage limit has been reached");
    expect(result.timedOut).toBe(false);
  });
});

describe("a child parked on a question", () => {
  function sessionLine(parts: {
    role?: "assistant" | "user";
    text?: string;
    toolName?: string;
    toolArgs?: unknown;
    stopReason?: string;
  }): string {
    const content: unknown[] = [];
    if (parts.toolName) {
      content.push({ type: "toolCall", id: "t-1", name: parts.toolName, arguments: parts.toolArgs ?? {} });
    }
    if (parts.text !== undefined) content.push({ type: "text", text: parts.text });
    return JSON.stringify({
      type: "message",
      id: `m-${Math.random().toString(36).slice(2, 8)}`,
      message: {
        role: parts.role ?? "assistant",
        content,
        ...(parts.stopReason ? { stopReason: parts.stopReason } : {}),
      },
    });
  }

  function writeSession(dir: string, lines: string[]): string {
    const sessionFile = path.join(dir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [JSON.stringify({ type: "session", id: "s-ask" }), ...lines].join("\n") + "\n",
      "utf-8",
    );
    return sessionFile;
  }

  const askParent = sessionLine({
    stopReason: "toolUse",
    toolName: "agent_message",
    toolArgs: { action: "send", to: "VividQuartz", message: "Which branch should I diff against?" },
  });

  async function settle(sessionFile: string, tempDir: string) {
    return await waitForSettledSessionResult({
      sessionFile,
      exitMarkerPath: path.join(tempDir, "missing.exit"),
      timeoutMs: 30_000,
      idleGraceMs: 100,
      parentAgentName: "VividQuartz",
    });
  }

  test("is reported as awaiting a reply instead of finished", async () => {
    const tempDir = makeTempDir("collab-await-reply");
    const sessionFile = writeSession(tempDir, [
      askParent,
      sessionLine({ text: "Asked the coordinator; waiting." }),
    ]);

    const result = await settle(sessionFile, tempDir);

    // Going quiet after a question used to look exactly like finishing, so the
    // coordinator harvested the question as the result and replaced the child.
    expect(result.awaitingReply).toBe("Which branch should I diff against?");
    expect(result.timedOut).toBe(false);
  });

  test("carrying on with more tool work is finishing, not waiting", async () => {
    const tempDir = makeTempDir("collab-await-continued");
    const sessionFile = writeSession(tempDir, [
      askParent,
      sessionLine({ stopReason: "toolUse", toolName: "bash", toolArgs: { command: "git diff" } }),
      sessionLine({ text: "Done: three files changed." }),
    ]);

    const result = await settle(sessionFile, tempDir);

    expect(result.awaitingReply).toBeUndefined();
    expect(result.terminalAssistantText).toBe("Done: three files changed.");
  });

  test("an answer arriving in the session clears the question", async () => {
    const tempDir = makeTempDir("collab-await-answered");
    const sessionFile = writeSession(tempDir, [
      askParent,
      sessionLine({ role: "user", text: "Diff against test." }),
      sessionLine({ text: "Done: three files changed." }),
    ]);

    const result = await settle(sessionFile, tempDir);

    expect(result.awaitingReply).toBeUndefined();
    expect(result.terminalAssistantText).toBe("Done: three files changed.");
  });

  test("a provider error the child retried past is not a failure", async () => {
    const tempDir = makeTempDir("collab-await-retried-error");
    // One "Request timed out." followed by Pi's own retry and more tool work used to
    // stick as the run's terminal error, so a later pause of a few seconds while
    // the child was still working settled the run as failed.
    const sessionFile = writeSession(tempDir, [
      sessionLine({ stopReason: "toolUse", toolName: "bash", toolArgs: { command: "git log" } }),
      JSON.stringify({
        type: "message",
        id: "m-err",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Request timed out." },
      }),
      sessionLine({ stopReason: "toolUse", toolName: "read", toolArgs: { path: "a.ts" } }),
    ]);
    setTimeout(() => {
      fs.appendFileSync(sessionFile, sessionLine({ text: "Done: three files changed." }) + "\n", "utf-8");
    }, 400);

    const result = await waitForSettledSessionResult({
      sessionFile,
      exitMarkerPath: path.join(tempDir, "missing.exit"),
      timeoutMs: 30_000,
      idleGraceMs: 100,
      errorSettleMs: 150,
      parentAgentName: "VividQuartz",
    });

    expect(result.terminalError).toBeUndefined();
    expect(result.terminalAssistantText).toBe("Done: three files changed.");
  });

  test("an answer arriving in the session supersedes the write-up that preceded it", async () => {
    const tempDir = makeTempDir("collab-await-superseded");
    // Asked, wrote a "blocked" report, then the coordinator's answer landed: that
    // report is no longer the child's final word, and nothing is final until the
    // resumed turn ends.
    const sessionFile = writeSession(tempDir, [
      askParent,
      sessionLine({ text: "Blocked before measuring anything. Report follows." }),
      sessionLine({ role: "user", text: "Diff against test." }),
    ]);
    setTimeout(() => {
      fs.appendFileSync(sessionFile, sessionLine({ text: "Done: three files changed." }) + "\n", "utf-8");
    }, 500);

    const result = await settle(sessionFile, tempDir);

    expect(result.awaitingReply).toBeUndefined();
    expect(result.terminalAssistantText).toBe("Done: three files changed.");
  });

  test("a final text older than the required user message is not a result yet", async () => {
    const tempDir = makeTempDir("collab-await-min-user");
    const sessionFile = writeSession(tempDir, [
      askParent,
      sessionLine({ text: "Blocked before measuring anything. Report follows." }),
    ]);
    setTimeout(() => {
      fs.appendFileSync(
        sessionFile,
        [sessionLine({ role: "user", text: "Diff against test." }), sessionLine({ text: "Done." })].join("\n") + "\n",
        "utf-8",
      );
    }, 500);

    const result = await waitForSettledSessionResult({
      sessionFile,
      exitMarkerPath: path.join(tempDir, "missing.exit"),
      timeoutMs: 30_000,
      idleGraceMs: 100,
      parentAgentName: "VividQuartz",
      minUserMessages: 1,
    });

    expect(result.awaitingReply).toBeUndefined();
    expect(result.terminalAssistantText).toBe("Done.");
  });

  test("a message to a sibling is collaboration, not a question for the coordinator", async () => {
    const tempDir = makeTempDir("collab-await-sibling");
    const sessionFile = writeSession(tempDir, [
      sessionLine({
        stopReason: "toolUse",
        toolName: "agent_message",
        toolArgs: { action: "send", to: "GoldenSun", message: "Taking the CO processors." },
      }),
      sessionLine({ text: "Done." }),
    ]);

    const result = await settle(sessionFile, tempDir);

    expect(result.awaitingReply).toBeUndefined();
    expect(result.terminalAssistantText).toBe("Done.");
  });

  test("an exited child is settled normally, because its session cannot be resumed", async () => {
    const tempDir = makeTempDir("collab-await-exited");
    const sessionFile = writeSession(tempDir, [askParent, sessionLine({ text: "Waiting." })]);
    const exitMarkerPath = path.join(tempDir, "run.exit");
    fs.writeFileSync(exitMarkerPath, "0\n", "utf-8");

    const result = await waitForSettledSessionResult({
      sessionFile,
      exitMarkerPath,
      timeoutMs: 30_000,
      idleGraceMs: 100,
      parentAgentName: "VividQuartz",
    });

    expect(result.awaitingReply).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});

describe("subagent spawn", () => {
  test("inherits parent profile directories in subagent panes without inventing them", () => {
    const inherited = collectInheritedPaneEnv({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: "/tmp/pi-personal",
      CLAUDE_CONFIG_DIR: "/tmp/claude-personal",
      EMPTY_VALUE: "",
    });

    expect(inherited).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: "/tmp/pi-personal",
      CLAUDE_CONFIG_DIR: "/tmp/claude-personal",
    });
    expect(collectInheritedPaneEnv({ PATH: "/usr/bin" })).toEqual({ PATH: "/usr/bin" });
  });

  test("passes type prompt via --append-system-prompt and redacts it in launch details", async () => {
    const tempDir = makeTempDir("collab-subagent-spawn");
    const { binPath, argsFile } = writeFakePiBinary(tempDir);

    expect(fs.existsSync(binPath)).toBe(true);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const typePrompt = "You are a scout. Return concise findings.";
    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: typePrompt,
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun1",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    const appendFlagIndex = capturedArgs.indexOf("--append-system-prompt");
    expect(appendFlagIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[appendFlagIndex + 1]).toBe(typePrompt);

    const runtimeTaskPrompt = capturedArgs[capturedArgs.length - 1];
    expect(runtimeTaskPrompt).toBe("Find all TypeScript files");
    expect(runtimeTaskPrompt).not.toContain("Do not send a mandatory final summary message");

    const launchAppendFlagIndex = result.launchArgs.indexOf("--append-system-prompt");
    expect(launchAppendFlagIndex).toBeGreaterThanOrEqual(0);
    expect(result.launchArgs[launchAppendFlagIndex + 1]).toBe(`<subagent-type-prompt:${typePrompt.length} chars>`);

    expect(result.launchCommand).toContain("--append-system-prompt");
    expect(result.launchCommand).toContain(`<subagent-type-prompt:${typePrompt.length} chars>`);
    expect(result.launchCommand).not.toContain(typePrompt);

    expect(result.launchSystemPromptSource).toBe("/tmp/scout.toml");
    expect(result.launchSystemPromptLength).toBe(typePrompt.length);
  });

  test("passes agentDir to the child as PI_CODING_AGENT_DIR and inherits the parent's when unset", async () => {
    const tempDir = makeTempDir("collab-subagent-agent-dir");
    const { argsFile } = writeFakePiBinary(tempDir);
    const envFile = path.join(tempDir, "captured-env.json");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_ENV_FILE = envFile;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-parent";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "",
      source: "bundled",
      filePath: "/tmp/worker.toml",
    };

    try {
      const withDir = await runSpawnTask(
        tempDir,
        { agent: "worker", task: "noop" },
        agentDef,
        { index: 0, runId: "agentdir1", recursionDepth: 0, agentDir: "/tmp/pi-sub" },
      );
      expect(withDir.exitCode).toBe(0);
      expect(withDir.launchEnv.PI_CODING_AGENT_DIR).toBe("/tmp/pi-sub");
      expect(JSON.parse(fs.readFileSync(envFile, "utf-8"))).toEqual({
        PI_CODING_AGENT_DIR: "/tmp/pi-sub",
        COLLABORATING_AGENTS_DIR: path.join("/tmp/pi-parent", "collaborating-agents"),
      });

      const inherited = await runSpawnTask(
        tempDir,
        { agent: "worker", task: "noop" },
        agentDef,
        { index: 1, runId: "agentdir2", recursionDepth: 0 },
      );
      expect(inherited.exitCode).toBe(0);
      expect(inherited.launchEnv.PI_CODING_AGENT_DIR).toBeUndefined();
      // The child stays on the parent's bus even though its default would now be its own profile's.
      expect(JSON.parse(fs.readFileSync(envFile, "utf-8"))).toEqual({
        PI_CODING_AGENT_DIR: "/tmp/pi-parent",
        COLLABORATING_AGENTS_DIR: inherited.launchEnv.COLLABORATING_AGENTS_DIR,
      });
      expect(inherited.launchEnv.COLLABORATING_AGENTS_DIR).toBe(path.join("/tmp/pi-parent", "collaborating-agents"));
    } finally {
      delete process.env.TEST_ENV_FILE;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  test("preserves requested extension tools in the child --tools allow-list", async () => {
    const tempDir = makeTempDir("collab-subagent-extension-tools");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Use coordination tools when needed.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "agent_message", "custom_project_tool", "read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Coordinate with the parent",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-extension-tools",
        recursionDepth: 0,
      },
    );

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    const toolsFlagIndex = capturedArgs.indexOf("--tools");
    expect(toolsFlagIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[toolsFlagIndex + 1]).toBe("read,agent_message,custom_project_tool");
    expect(result.resolvedTools).toEqual(["read", "agent_message", "custom_project_tool"]);
  });

  test("notifies process-mode session metadata when json session events are observed", async () => {
    const tempDir = makeTempDir("collab-subagent-process-session-metadata");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };
    const observedMetadata: Array<{ name: string; sessionId?: string; sessionFile?: string }> = [];

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-metadata",
        recursionDepth: 0,
        onSessionMetadata: (metadata) => {
          observedMetadata.push(metadata);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.sessionFile).toBeUndefined();
    expect(result.sessionFileUnavailableReason).toBe("Process-mode session file unavailable until child registration or fallback discovery provides one.");
    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs).not.toContain("--session");
    expect(observedMetadata).toEqual([
      {
        name: result.name,
        sessionId: "fake-session",
      },
    ]);
  });

  test("accepts process-mode assistant output emitted as message events", async () => {
    const tempDir = makeTempDir("collab-subagent-process-assistant-message");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_PI_PROCESS_MESSAGE_EVENT = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-message",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("fake-session");
  });

  test("treats process-mode assistant errors as failed even when pi exits cleanly", async () => {
    const tempDir = makeTempDir("collab-subagent-process-assistant-error");
    writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_PI_ASSISTANT_ERROR = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-assistant-error",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("Error: fetch failed");
    expect(result.error).toBe("Error: fetch failed");
    expect(result.sessionId).toBe("fake-session");
  });

  test("keeps process-mode assistant errors preferred over stderr on non-zero exit", async () => {
    const tempDir = makeTempDir("collab-subagent-process-assistant-error-stderr");
    writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_PI_ASSISTANT_ERROR = "1";
    process.env.TEST_PI_PROCESS_STDERR = "subagent crashed";
    process.env.TEST_PI_PROCESS_EXIT_CODE = "2";

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-assistant-error-stderr",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toBe("Error: fetch failed");
    expect(result.error).toBe("Error: fetch failed");
    expect(result.sessionId).toBe("fake-session");
  });

  test("uses the latest process-mode assistant message after a transient assistant error", async () => {
    const tempDir = makeTempDir("collab-subagent-process-transient-assistant-error");
    writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-transient-assistant-error",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-final-after-error");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("fake-session");
  });

  test("swallows process-mode session metadata callback failures", async () => {
    const tempDir = makeTempDir("collab-subagent-process-session-metadata-failure");
    writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-metadata-failure",
        recursionDepth: 0,
        onSessionMetadata: () => {
          throw new Error("metadata failed");
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.warnings).toContain("Session metadata callback failed: metadata failed");
  });

  test("includes self-registered session file in process-mode session metadata", async () => {
    const tempDir = makeTempDir("collab-subagent-process-session-metadata-registration");
    writeFakePiBinary(tempDir);

    const stateDir = path.join(tempDir, "state");
    const sessionFile = path.join(tempDir, "self-registered-session.jsonl");
    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.COLLABORATING_AGENTS_DIR = stateDir;
    process.env.TEST_PI_REGISTER_SELF = "1";
    process.env.TEST_PI_REGISTER_SESSION_FILE = sessionFile;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };
    const observedMetadata: Array<{ name: string; sessionId?: string; sessionFile?: string }> = [];

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "scout",
        task: "Find all TypeScript files",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-process-registration",
        recursionDepth: 0,
        onSessionMetadata: (metadata) => {
          observedMetadata.push(metadata);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.sessionFile).toBe(sessionFile);
    expect(result.sessionFileUnavailableReason).toBeUndefined();
    expect(observedMetadata).toEqual([
      {
        name: result.name,
        sessionId: "fake-session",
        sessionFile,
      },
    ]);
  });

  test("omits append-system-prompt for blank type prompt and wraps task with parent context", async () => {
    const tempDir = makeTempDir("collab-subagent-parent-context");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "doc-helper",
      description: "Doc helper",
      systemPrompt: "   \n\t",
      source: "user",
      filePath: "/tmp/doc-helper.md",
      tools: ["agent_message"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "doc-helper",
        task: "Write docs",
      },
      agentDef,
      {
        index: 1,
        runId: "testrun2",
        recursionDepth: 2,
        parentAgentName: "RapidRiver",
      },
    );

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs.includes("--append-system-prompt")).toBe(false);
    const toolsFlagIndex = capturedArgs.indexOf("--tools");
    expect(toolsFlagIndex).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[toolsFlagIndex + 1]).toBe("agent_message");

    const expectedPrompt = "Parent agent: RapidRiver\n\nWrite docs";
    expect(capturedArgs[capturedArgs.length - 1]).toBe(expectedPrompt);
    expect(result.launchPrompt).toBe(expectedPrompt);
    expect(result.coordinator).toBe("RapidRiver");

    expect(result.launchSystemPromptSource).toBeUndefined();
    expect(result.launchSystemPromptLength).toBeUndefined();
  });

  test("returns stderr as output and sets error on non-zero exit when no assistant message is emitted", async () => {
    const tempDir = makeTempDir("collab-subagent-stderr-fallback");
    writeFailingFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;

    const agentDef: SpawnAgentDefinition = {
      name: "broken",
      description: "Broken",
      systemPrompt: "Return status",
      source: "bundled",
      filePath: "/tmp/broken.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "broken",
        task: "Run",
      },
      agentDef,
      {
        index: 2,
        runId: "testrun3",
        recursionDepth: 0,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.output).toBe("subagent crashed");
    expect(result.error).toBe("subagent crashed");
  });


  test("accepts pane assistant output emitted as message_end events", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-assistant-message-end");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "1800";
    process.env.TEST_PI_SESSION_MESSAGE_END_EVENT = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-message-end",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("fake-session");
    expect(result.paneClosed).toBe(true);
  }, 10000);

  test("treats pane assistant errors as failed even when pi exits cleanly", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-assistant-error");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_ASSISTANT_ERROR = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-error",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("Error: fetch failed");
    expect(result.error).toBe("Error: fetch failed");
    expect(result.sessionId).toBe("fake-session");
    expect(result.paneClosed).toBeUndefined();

    const capturedHerdrArgs = getCapturedHerdrArgs(herdrArgsFile);
    expect(capturedHerdrArgs.map((entry) => entry[1])).not.toContain("close");
  });

  test("does not fail a still-running pane subagent on a transient assistant error", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-transient-assistant-error");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_ASSISTANT_ERROR_THEN_FINAL = "1";
    process.env.TEST_PI_EXIT_DELAY_MS = "1800";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-transient-error",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        paneResultTimeoutMs: 5000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-final-after-error");
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe("fake-session");
    expect(result.paneClosed).toBe(true);
  }, 10000);

  test("does not fail a pane subagent whose session file appears after the startup grace", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-delayed-session");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_SESSION_CREATE_DELAY_MS = "10500";
    process.env.TEST_PI_EXIT_DELAY_MS = "11000";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-delayed-session",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        paneResultTimeoutMs: 15000,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.paneClosed).toBe(true);
  }, 20000);

  test("notifies pane session metadata with the explicit session file", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-session-metadata");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };
    const observedMetadata: Array<{ name: string; sessionId?: string; sessionFile?: string }> = [];

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-pane-metadata",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        onSessionMetadata: (metadata) => {
          observedMetadata.push(metadata);
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.sessionFile).toBeString();
    expect(observedMetadata).toEqual([
      {
        name: result.name,
        sessionId: "fake-session",
        sessionFile: result.sessionFile,
      },
    ]);
  });

  test("waits for the latest settled assistant message before closing a pane", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-settled-output");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "5000";
    process.env.TEST_PI_MULTI_TURN = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-settled",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-final");
    expect(result.paneClosed).toBe(true);
  });

  test("a pane child in another profile still gets the parent's bus pinned", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-bus-pin");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);
    const envFile = path.join(tempDir, "child-env.json");

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_ENV_FILE = envFile;
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousBus = process.env.COLLABORATING_AGENTS_DIR;
    process.env.PI_CODING_AGENT_DIR = "/tmp/pi-parent";
    delete process.env.COLLABORATING_AGENTS_DIR;

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    try {
      // The process-mode env already carried the pin; the pane launch script builds
      // its env separately and dropped it, so a ~/.pi-sub child saw zero peers.
      const result = await runSpawnTask(
        tempDir,
        { agent: "worker", task: "Inspect the repository" },
        agentDef,
        { index: 0, runId: "pane-bus-pin", recursionDepth: 0, launchMode: "herdr-pane", agentDir: "/tmp/pi-sub" },
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(envFile, "utf-8"))).toEqual({
        PI_CODING_AGENT_DIR: "/tmp/pi-sub",
        COLLABORATING_AGENTS_DIR: path.join("/tmp/pi-parent", "collaborating-agents"),
      });
    } finally {
      delete process.env.TEST_ENV_FILE;
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousBus !== undefined) process.env.COLLABORATING_AGENTS_DIR = previousBus;
    }
  });

  test("extends the pane result timeout while the session file is still actively changing", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-active-timeout-extension");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "2500";
    process.env.TEST_PI_MULTI_TURN = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-active-timeout",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        paneResultTimeoutMs: 500,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-final");
    expect(result.paneClosed).toBe(true);
  });

  test("detects successful pane completion even when the final session write preserves mtime", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-stable-mtime");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "5000";
    process.env.TEST_PI_SAME_MTIME_FINAL_ONLY = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const startedAt = Date.now();
    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun4-stable-mtime",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        paneResultTimeoutMs: 1800,
      },
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(4500);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.paneClosed).toBe(true);
  });

  test("can keep completed panes open when auto-close is disabled", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-no-close");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "5000";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const startedAt = Date.now();
    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun5",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        closeCompletedPane: false,
      },
    );

    expect(Date.now() - startedAt).toBeLessThan(4500);
    expect(result.exitCode).toBe(0);
    expect(result.paneClosed).toBeUndefined();
    expect(result.paneCloseError).toBeUndefined();
  });


  test("uses the legacy balanced pane layout when orchestrator preservation is disabled by default", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-layout");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    for (let index = 0; index < 3; index += 1) {
      const result = await runSpawnTask(
        tempDir,
        {
          agent: "worker",
          task: `Inspect repository ${index}`,
        },
        agentDef,
        {
          index,
          runId: `testrun-layout-${index}`,
          recursionDepth: 0,
          launchMode: "herdr-pane",
          closeCompletedPane: false,
        },
      );

      expect(result.exitCode).toBe(0);
    }

    const capturedHerdrArgs = getCapturedHerdrArgs(herdrArgsFile);

    const splitCommands = capturedHerdrArgs.filter((entry) => entry[1] === "split");
    const splitTargets = splitCommands.map((entry) => entry[entry.indexOf("--pane") + 1]);
    const splitDirections = splitCommands.map((entry) => entry[entry.indexOf("--direction") + 1]);

    expect(splitTargets).toEqual(["w1:p1", "w1:p2", "w1:p1"]);
    expect(splitDirections).toEqual(["right", "down", "down"]);
  });

  test("preserves the orchestrator half while balancing sequential launches within the subagent subtree", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-preserved-layout");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    for (let index = 0; index < 6; index += 1) {
      const result = await runSpawnTask(
        tempDir,
        { agent: "worker", task: `Inspect preserved repository ${index}` },
        agentDef,
        {
          index,
          runId: `testrun-preserved-layout-${index}`,
          recursionDepth: 0,
          launchMode: "herdr-pane",
          closeCompletedPane: false,
          preserveOrchestratorPane: true,
        },
      );

      expect(result.exitCode).toBe(0);
    }

    const splitTargets = getCapturedHerdrArgs(herdrArgsFile)
      .filter((entry) => entry[1] === "split")
      .map((entry) => entry[entry.indexOf("--pane") + 1]);

    expect(splitTargets).toEqual(["w1:p1", "w1:p2", "w1:p2", "w1:p3", "w1:p2", "w1:p3"]);
    expect(splitTargets.slice(1)).not.toContain("w1:p1");
  });

  test("retries a failed preserved split on another live subagent pane", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-preserved-retry");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    for (let index = 0; index < 2; index += 1) {
      const result = await runSpawnTask(
        tempDir,
        { agent: "worker", task: `Prepare preserved pane ${index}` },
        agentDef,
        {
          index,
          runId: `testrun-preserved-retry-${index}`,
          recursionDepth: 0,
          launchMode: "herdr-pane",
          closeCompletedPane: false,
          preserveOrchestratorPane: true,
        },
      );
      expect(result.exitCode).toBe(0);
    }

    process.env.TEST_HERDR_FAIL_SPLIT_PANE = "w1:p2";
    const retryResult = await runSpawnTask(
      tempDir,
      { agent: "worker", task: "Retry away from orchestrator" },
      agentDef,
      {
        index: 2,
        runId: "testrun-preserved-retry-2",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        closeCompletedPane: false,
        preserveOrchestratorPane: true,
      },
    );
    delete process.env.TEST_HERDR_FAIL_SPLIT_PANE;

    expect(retryResult.exitCode).toBe(0);
    const panelTargets = getCapturedHerdrArgs(herdrArgsFile)
      .filter((entry) => entry[1] === "split")
      .map((entry) => entry[entry.indexOf("--pane") + 1]);
    expect(panelTargets.slice(-2)).toEqual(["w1:p2", "w1:p3"]);
    expect(panelTargets.slice(1)).not.toContain("w1:p1");
  });

  test("removes auto-closed panes from the preserved layout before falling back to the orchestrator", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-layout-close");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    for (let index = 0; index < 2; index += 1) {
      const result = await runSpawnTask(
        tempDir,
        {
          agent: "worker",
          task: `Inspect repository ${index}`,
        },
        agentDef,
        {
          index,
          runId: `testrun-layout-close-${index}`,
          recursionDepth: 0,
          launchMode: "herdr-pane",
          preserveOrchestratorPane: true,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.paneClosed).toBe(true);
    }

    const capturedHerdrArgs = getCapturedHerdrArgs(herdrArgsFile);

    const splitTargets = capturedHerdrArgs
      .filter((entry) => entry[1] === "split")
      .map((entry) => entry[entry.indexOf("--pane") + 1]);

    expect(splitTargets).toEqual(["w1:p1", "w1:p1"]);
  });


  test("snapshot sync drops manually closed panes before choosing the next split target", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-snapshot-sync");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const first = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect repository 0",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun-snapshot-sync-0",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        closeCompletedPane: false,
      },
    );
    expect(first.exitCode).toBe(0);

    // The developer closed the subagent's pane by hand between launches.
    const state = readFakeHerdrState(herdrArgsFile);
    state.panes = state.panes.filter((pane) => pane !== "w1:p2");
    writeFakeHerdrState(herdrArgsFile, state);

    const second = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect repository 1",
      },
      agentDef,
      {
        index: 1,
        runId: "testrun-snapshot-sync-1",
        recursionDepth: 0,
        launchMode: "herdr-pane",
        closeCompletedPane: false,
      },
    );
    expect(second.exitCode).toBe(0);

    const capturedHerdrArgs = getCapturedHerdrArgs(herdrArgsFile);
    const splitTargets = capturedHerdrArgs
      .filter((entry) => entry[1] === "split")
      .map((entry) => entry[entry.indexOf("--pane") + 1]);

    expect(splitTargets).toEqual(["w1:p1", "w1:p1"]);
  });

  test("auto-closes after turn-finished output plus idle grace even if pane process stays open longer", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-idle-grace-close");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "5000";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const startedAt = Date.now();
    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun6",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(4500);
    expect(result.exitCode).toBe(0);
    expect(result.paneClosed).toBe(true);
  });

  test("keeps pane open when process exits non-zero during idle grace after emitting final output", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-nonzero-after-output");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_PI_EXIT_DELAY_MS = "150";
    process.env.TEST_PI_EXIT_CODE = "7";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun7",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(7);
    expect(result.paneClosed).toBeUndefined();
    expect(result.error).toContain("exited with code 7");
  });

  test("reports close failure without treating the successful pane subagent as failed", async () => {
    const tempDir = makeTempDir("collab-subagent-pane-close-fails");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_HERDR_CLOSE_FAIL = "1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      {
        agent: "worker",
        task: "Inspect the repository",
      },
      agentDef,
      {
        index: 0,
        runId: "testrun8",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.paneClosed).toBeUndefined();
    expect(result.paneCloseError).toContain("close failed");
  });
});

describe("spawn agent discovery", () => {
  test("project agents override user agents and malformed files are ignored", () => {
    const homeDir = makeTempDir("collab-spawn-agents-home");
    setHome(homeDir);

    writeAgentMarkdown(path.join(homeDir, ".pi", "agents"), "reviewer.md", {
      name: "reviewer",
      description: "User reviewer",
      model: "gpt-5",
      tools: "read, bash",
      promptBody: "User reviewer prompt",
    });

    writeAgentMarkdown(path.join(homeDir, ".pi", "agents"), "invalid.md", {
      name: "invalid",
      promptBody: "Missing description",
    });

    writeAgentMarkdown(path.join(homeDir, ".pi", "agents"), "skip.chain.md", {
      name: "skip",
      description: "Should be skipped",
    });

    const projectRoot = makeTempDir("collab-spawn-agents-project");
    writeAgentMarkdown(path.join(projectRoot, ".pi", "agents"), "reviewer.md", {
      name: "reviewer",
      description: "Project reviewer",
      tools: "read,write",
      promptBody: "Project reviewer prompt",
    });

    writeAgentMarkdown(path.join(projectRoot, ".pi", "agents"), "writer.md", {
      name: "writer",
      description: "Project writer",
      model: "gpt-4.1",
      tools: "read, bash ,edit",
      promptBody: "Writer prompt",
    });

    const nestedCwd = path.join(projectRoot, "packages", "api");
    fs.mkdirSync(nestedCwd, { recursive: true });

    const discovered = discoverSpawnAgents(nestedCwd);

    expect(discovered.map((a) => a.name)).toEqual(["reviewer", "writer"]);

    const reviewer = discovered.find((a) => a.name === "reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.source).toBe("project");
    expect(reviewer?.description).toBe("Project reviewer");
    expect(reviewer?.tools).toEqual(["read", "write"]);

    const writer = discovered.find((a) => a.name === "writer");
    expect(writer).toBeDefined();
    expect(writer?.source).toBe("project");
    expect(writer?.model).toBe("gpt-4.1");
    expect(writer?.tools).toEqual(["read", "bash", "edit"]);
  });
});

describe("spawn agent resolution", () => {
  test("returns ambiguous suggestions when requested suffix matches multiple agent names", () => {
    const available: SpawnAgentDefinition[] = [
      {
        name: "frontend-reviewer",
        description: "Frontend reviewer",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/frontend.md",
      },
      {
        name: "backend-reviewer",
        description: "Backend reviewer",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/backend.md",
      },
      {
        name: "security-auditor",
        description: "Security auditor",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/security.md",
      },
    ];

    const resolved = resolveSpawnAgentDefinition("reviewer", available);

    expect(resolved.definition).toBeUndefined();
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.suggestions).toEqual(["frontend-reviewer", "backend-reviewer"]);
  });

  test("normalizes underscores and spaces for exact-name resolution", () => {
    const available: SpawnAgentDefinition[] = [
      {
        name: "backend-reviewer",
        description: "Backend reviewer",
        systemPrompt: "",
        source: "project",
        filePath: "/tmp/backend.md",
      },
    ];

    const resolved = resolveSpawnAgentDefinition(" backend_reviewer ", available);

    expect(resolved.definition?.name).toBe("backend-reviewer");
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.suggestions).toEqual(["backend-reviewer"]);
  });
});

describe("concurrency-limited mapping", () => {
  test("preserves output order even when work completes out of order", async () => {
    const values = [10, 40, 5, 25];

    const outputs = await mapWithConcurrencyLimit(values, 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return `done-${value}`;
    });

    expect(outputs).toEqual(["done-10", "done-40", "done-5", "done-25"]);
  });
});

/** The herdr fake appends one JSON array per invocation. */
function getCapturedHerdrArgs(argsFile: string): string[][] {
  if (!fs.existsSync(argsFile)) return [];
  return fs
    .readFileSync(argsFile, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

/**
 * Minimal `herdr` stand-in. Herdr's flat workspace->pane model needs far less
 * state: a pane list, a pending send-text buffer per pane,
 * and the JSON envelope every command answers with.
 */
function writeFakeHerdrBinary(dir: string): { binPath: string; argsFile: string } {
  const binPath = path.join(dir, "herdr");
  const argsFile = path.join(dir, "captured-herdr-args.jsonl");

  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const cp = require("node:child_process");

const args = process.argv.slice(2);
const argsFile = process.env.TEST_HERDR_ARGS_FILE;
const stateFile = argsFile ? argsFile + ".state.json" : null;
if (argsFile) {
  fs.appendFileSync(argsFile, JSON.stringify(args) + "\\n", "utf-8");
}

function initialState() {
  return { nextPane: 2, panes: ["w1:p1"], pending: {} };
}

function readState() {
  if (!stateFile || !fs.existsSync(stateFile)) return initialState();
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf-8"));
  } catch {
    return initialState();
  }
}

function writeState(state) {
  if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state), "utf-8");
}

function paneInfo(id) {
  return { agent_status: "unknown", focused: false, pane_id: id, tab_id: "w1:t1", workspace_id: "w1" };
}

function ok(result) {
  process.stdout.write(JSON.stringify({ id: "cli:test", result: result }) + "\\n");
  process.exit(0);
}

// Real herdr reports failures on stderr and exits non-zero, while send-text and
// send-keys succeed with no output at all.
function fail(code, message) {
  process.stderr.write(JSON.stringify({ error: { code: code, message: message }, id: "cli:test" }) + "\\n");
  process.exit(1);
}

function silentOk() {
  process.exit(0);
}

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

if (args[0] !== "pane") fail("unsupported", "only pane commands are faked");

const command = args[1];
const state = readState();

if (command === "list") {
  ok({ panes: state.panes.map(paneInfo), type: "pane_list" });
}

if (command === "split") {
  const target = flag("--pane");
  if (!target || state.panes.indexOf(target) < 0) fail("pane_not_found", "pane " + target + " not found");
  if (process.env.TEST_HERDR_FAIL_SPLIT_PANE && target === process.env.TEST_HERDR_FAIL_SPLIT_PANE) {
    fail("split_failed", "split on " + target + " failed");
  }
  const id = "w1:p" + state.nextPane;
  state.nextPane += 1;
  state.panes.push(id);
  writeState(state);
  ok({ pane: paneInfo(id), type: "pane_info" });
}

if (command === "send-text") {
  state.pending[args[2]] = args[3] || "";
  writeState(state);
  silentOk();
}

if (command === "send-keys") {
  if (args[3] !== "Enter") silentOk();
  const pending = state.pending[args[2]] || "";
  delete state.pending[args[2]];
  writeState(state);
  // Real herdr returns as soon as the keys are typed; the pane keeps running on
  // its own. Tests that measure idle grace need that, or the launch call itself
  // blocks for the child's whole life and every budget is measured wrong.
  if (process.env.TEST_HERDR_SEND_ASYNC === "1") {
    const child = cp.spawn("/bin/bash", ["-lc", pending], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "ignore",
      detached: true,
    });
    child.unref();
    silentOk();
  }
  const result = cp.spawnSync("/bin/bash", ["-lc", pending], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail("run_failed", String(result.error));
  silentOk();
}

if (command === "close") {
  if (process.env.TEST_HERDR_CLOSE_FAIL === "1") fail("close_failed", "close failed");
  state.panes = state.panes.filter((pane) => pane !== args[2]);
  writeState(state);
  ok({ type: "ok" });
}

if (command === "read") {
  process.stdout.write("fake herdr pane screen\\n");
  process.exit(0);
}

fail("unsupported", "unknown pane command " + command);
`;

  fs.writeFileSync(binPath, script, { encoding: "utf-8", mode: 0o755 });
  return { binPath, argsFile };
}

describe("herdr pane launch mode", () => {
  const agentDef: SpawnAgentDefinition = {
    name: "worker",
    description: "Worker",
    systemPrompt: "Return concise findings.",
    source: "bundled",
    filePath: "/tmp/worker.toml",
    tools: ["read", "bash"],
  };

  test("launches a subagent in a herdr pane and collects final session output", async () => {
    const tempDir = makeTempDir("collab-subagent-herdr-pane");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const result = await runSpawnTask(
      tempDir,
      { agent: "worker", task: "Inspect the repository" },
      agentDef,
      {
        index: 0,
        runId: "testrunherdr",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("fake-ok");
    expect(result.sessionId).toBe("fake-session");
    expect(result.launchMode).toBe("herdr-pane");

    // Herdr has no surface layer, so the pane id stands in for both refs.
    expect(result.workspaceRef).toBe("w1");
    expect(result.paneRef).toBe("w1:p2");
    expect(result.surfaceRef).toBe("w1:p2");
    expect(result.paneClosed).toBe(true);
    expect(result.paneCloseError).toBeUndefined();

    const captured = getCapturedHerdrArgs(herdrArgsFile);
    expect(captured.map((entry) => `${entry[0]} ${entry[1]}`)).toEqual([
      "pane list",
      "pane split",
      "pane send-text",
      "pane send-keys",
      "pane close",
    ]);

    const splitArgs = captured[1]!;
    expect(splitArgs).toContain("--pane");
    expect(splitArgs).toContain("w1:p1");
    expect(splitArgs).toContain("--direction");
    expect(splitArgs).toContain("right");
    expect(splitArgs).toContain("--cwd");

    const sendTextArgs = captured[2]!;
    expect(sendTextArgs[2]).toBe("w1:p2");
    expect(sendTextArgs[3]).toContain("bash ");
    expect(sendTextArgs[3]).not.toContain("--mode json -p");

    const capturedPiArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedPiArgs).toContain("--session");
    expect(capturedPiArgs[capturedPiArgs.length - 1]).toBe("Inspect the repository");

    expect(captured[4]!).toEqual(["pane", "close", "w1:p2"]);
  });

  test("refuses to launch when the orchestrator is not inside a herdr pane", async () => {
    const tempDir = makeTempDir("collab-subagent-herdr-pane-outside");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;

    const result = await runSpawnTask(
      tempDir,
      { agent: "worker", task: "Inspect the repository" },
      agentDef,
      {
        index: 0,
        runId: "testrunherdroutside",
        recursionDepth: 0,
        launchMode: "herdr-pane",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("HERDR_ENV");
    expect(fs.existsSync(herdrArgsFile)).toBe(false);
  });

  test("reports the close failure instead of claiming the pane was closed", async () => {
    const tempDir = makeTempDir("collab-subagent-herdr-pane-close-fail");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";
    process.env.TEST_HERDR_CLOSE_FAIL = "1";

    try {
      const result = await runSpawnTask(
        tempDir,
        { agent: "worker", task: "Inspect the repository" },
        agentDef,
        {
          index: 0,
          runId: "testrunherdrclose",
          recursionDepth: 0,
          launchMode: "herdr-pane",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.paneClosed).toBeUndefined();
      expect(result.paneCloseError).toBe("close_failed: close failed");
    } finally {
      delete process.env.TEST_HERDR_CLOSE_FAIL;
    }
  });
});

describe("answering a parked subagent", () => {
  test("types the answer into the live pane and settles on what the child does next", async () => {
    const tempDir = makeTempDir("collab-reply-delivery");
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);
    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;

    // The transcript ends on the turn that asked the question: the task prompt, the
    // question, and a "blocked" write-up. That write-up is the last assistant text
    // on disk when the reply is typed in, and it used to be harvested as the result
    // of the reply before the child had even started its next turn.
    const line = (id: string, message: Record<string, unknown>) => JSON.stringify({ type: "message", id, message });
    const sessionFile = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s-reply" }),
        line("m-0", { role: "user", content: [{ type: "text", text: "Diff the branch." }] }),
        line("m-1", {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "t-1",
              name: "agent_message",
              arguments: { action: "send", to: "VividQuartz", message: "Which branch?" },
            },
          ],
        }),
        line("m-2", { role: "assistant", content: [{ type: "text", text: "Blocked: no branch named. Report follows." }] }),
      ].join("\n") + "\n",
      "utf-8",
    );

    // The pane records the answer and the resumed turn a little after delivery.
    setTimeout(() => {
      fs.appendFileSync(
        sessionFile,
        [
          line("m-3", { role: "user", content: [{ type: "text", text: "Diff against test." }] }),
          line("m-4", {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "t-2", name: "bash", arguments: { command: "git diff test" } }],
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
    }, 400);
    setTimeout(() => {
      fs.appendFileSync(
        sessionFile,
        line("m-5", { role: "assistant", content: [{ type: "text", text: "Diffed against test: 3 files." }] }) + "\n",
        "utf-8",
      );
    }, 900);

    const outcome = await replyToSubagent({
      launchMode: "herdr-pane",
      paneRef: "w1:p2",
      sessionFile,
      message: "Diff against test.",
      parentAgentName: "VividQuartz",
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output).toBe("Diffed against test: 3 files.");
      expect(outcome.awaitingReply).toBeUndefined();
    }

    const captured = fs
      .readFileSync(herdrArgsFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);

    // send-text alone leaves the line sitting unsubmitted in the pane.
    expect(captured).toContainEqual(["pane", "send-text", "w1:p2", "Diff against test."]);
    expect(captured).toContainEqual(["pane", "send-keys", "w1:p2", "Enter"]);
  });

  test("startReplyToSubagent confirms delivery first and settles the resumed turn later", async () => {
    const tempDir = makeTempDir("collab-reply-background");
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);
    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;

    const line = (id: string, message: Record<string, unknown>) => JSON.stringify({ type: "message", id, message });
    const sessionFile = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s-bg" }),
        line("m-0", { role: "user", content: [{ type: "text", text: "Diff the branch." }] }),
        line("m-1", {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "t-1", name: "agent_message", arguments: { action: "send", to: "VividQuartz", message: "Which branch?" } },
          ],
        }),
        line("m-2", { role: "assistant", content: [{ type: "text", text: "Blocked. Report follows." }] }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const startedAt = Date.now();
    const started = await startReplyToSubagent({
      launchMode: "herdr-pane",
      paneRef: "w1:p2",
      sessionFile,
      message: "Diff against test.",
      parentAgentName: "VividQuartz",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Delivery is acknowledged without waiting for the child to do anything.
    expect(Date.now() - startedAt).toBeLessThan(1000);

    let settledEarly = false;
    void started.outcome.then(() => {
      settledEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settledEarly).toBe(false);

    fs.appendFileSync(
      sessionFile,
      [
        line("m-3", { role: "user", content: [{ type: "text", text: "Diff against test." }] }),
        line("m-4", { role: "assistant", content: [{ type: "text", text: "Diffed against test: 3 files." }] }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const outcome = await started.outcome;
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.output).toBe("Diffed against test: 3 files.");
      expect(outcome.awaitingReply).toBeUndefined();
    }
  });

  test("refuses to report a delivery when the child has already exited", async () => {
    const tempDir = makeTempDir("collab-reply-exited");
    const sessionFile = path.join(tempDir, "session.jsonl");
    fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "s-gone" }) + "\n", "utf-8");
    fs.writeFileSync(`${sessionFile}.exit`, "0\n", "utf-8");

    const outcome = await replyToSubagent({
      launchMode: "herdr-pane",
      paneRef: "w1:p2",
      sessionFile,
      message: "Diff against test.",
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("already exited");
  });
});


describe("profile-aware agent types and session files", () => {
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

  test("a personal-profile session sees ~/.pi-personal/agents, not the work profile's types", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "profile-types-"));
    tempDirs.push(home);
    const workAgents = path.join(home, ".pi", "agents");
    const personalAgents = path.join(home, ".pi-personal", "agents");
    fs.mkdirSync(workAgents, { recursive: true });
    fs.mkdirSync(personalAgents, { recursive: true });
    fs.writeFileSync(path.join(workAgents, "worker.md"), "---\nname: worker\ndescription: work\nmodel: github-copilot/claude-opus-5\n---\nx\n");
    fs.writeFileSync(path.join(personalAgents, "worker.md"), "---\nname: worker\ndescription: personal\nmodel: claude-bridge/claude-opus-5\n---\nx\n");
    const cwd = path.join(home, "MS", "web-ui"); // under $HOME, where ~/.pi/agents used to pass for a project dir
    fs.mkdirSync(cwd, { recursive: true });
    withEnv({ HOME: home, USERPROFILE: home, COLLABORATING_AGENTS_DIR: undefined, PI_CODING_AGENT_DIR: path.join(home, ".pi-personal", "agent") }, () => {
      const worker = discoverSpawnAgents(cwd).find((a) => a.name === "worker");
      expect(worker?.model).toBe("claude-bridge/claude-opus-5");
      expect(resolveSubagentSessionsDir()).toBe(path.join(home, ".pi-personal", "agent", "sessions", "collaborating-agents-subagents"));
    });
    withEnv({ HOME: home, USERPROFILE: home, COLLABORATING_AGENTS_DIR: undefined, PI_CODING_AGENT_DIR: undefined }, () => {
      expect(discoverSpawnAgents(cwd).find((a) => a.name === "worker")?.model).toBe("github-copilot/claude-opus-5");
    });
  });
});


describe("pane script profile env", () => {
  test("sources <profile>/pane-env.sh before pi, after the cd, only when the file exists", () => {
    const cmd = buildPaneCommand({
      piArgs: ["--name", "w"],
      env: { PATH: "/usr/bin" },
      cwd: "/tmp/repo",
      exitMarkerPath: "/tmp/m",
      profileEnvFile: "/home/u/.pi-personal/agent/pane-env.sh",
    });
    const source = "if [ -f /home/u/.pi-personal/agent/pane-env.sh ]; then . /home/u/.pi-personal/agent/pane-env.sh; fi";
    expect(cmd).toContain(source);
    const cdAt = cmd.indexOf("cd /tmp/repo || exit $?");
    const sourceAt = cmd.indexOf(source);
    const piAt = cmd.indexOf("env PATH=/usr/bin pi --name w");
    expect(cdAt).toBeGreaterThanOrEqual(0);
    expect(piAt).toBeGreaterThan(sourceAt);
    expect(sourceAt).toBeGreaterThan(cdAt);
    expect(buildPaneCommand({ piArgs: [], env: {}, cwd: "/tmp/repo", exitMarkerPath: "/tmp/m" })).not.toContain("pane-env");
  });

  test("the file lives in the session's profile", () => {
    const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, COLLABORATING_AGENTS_DIR: process.env.COLLABORATING_AGENTS_DIR };
    try {
      delete process.env.COLLABORATING_AGENTS_DIR;
      process.env.PI_CODING_AGENT_DIR = "/tmp/pi-personal/agent";
      expect(resolvePaneEnvFile()).toBe("/tmp/pi-personal/agent/pane-env.sh");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
describe("subagent spawn model provider selection", () => {
  test("should pass canonical provider/model as explicit --provider and --model flags", async () => {
    const tempDir = makeTempDir("collab-subagent-model-canonical");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      model: "github-copilot/claude-opus-4.7",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      { agent: "scout", task: "Find things" },
      agentDef,
      { index: 0, runId: "testrun-model-canonical", recursionDepth: 0 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.resolvedModel).toBe("github-copilot/claude-opus-4.7");
    expect(result.warnings).toBeUndefined();

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs).not.toContain("--models");
    const providerIdx = capturedArgs.indexOf("--provider");
    const modelIdx = capturedArgs.indexOf("--model");
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[providerIdx + 1]).toBe("github-copilot");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[modelIdx + 1]).toBe("claude-opus-4.7");

    expect(result.launchArgs).toContain("--provider");
    expect(result.launchArgs).toContain("github-copilot");
    expect(result.launchArgs).toContain("--model");
    expect(result.launchArgs).toContain("claude-opus-4.7");
    expect(result.launchArgs).not.toContain("--models");
    expect(result.launchCommand).toContain("--provider github-copilot");
    expect(result.launchCommand).toContain("--model claude-opus-4.7");
    expect(result.launchCommand).not.toContain("--models");
  });

  test("should forward the type's reasoning level as --thinking", async () => {
    const tempDir = makeTempDir("collab-subagent-reasoning");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "reviewer",
      description: "Reviewer",
      model: "github-copilot/gpt-5.6-sol",
      reasoning: "xhigh",
      systemPrompt: "Review only.",
      source: "bundled",
      filePath: "/tmp/reviewer.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      { agent: "reviewer", task: "Review things" },
      agentDef,
      { index: 0, runId: "testrun-reasoning", recursionDepth: 0 },
    );

    expect(result.exitCode).toBe(0);
    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    const thinkingIdx = capturedArgs.indexOf("--thinking");
    expect(thinkingIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[thinkingIdx + 1]).toBe("xhigh");
    expect(result.launchCommand).toContain("--thinking xhigh");
  });

  test("should not pass --thinking when the type sets no reasoning level", async () => {
    const tempDir = makeTempDir("collab-subagent-no-reasoning");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      model: "github-copilot/gemini-3.7-flash",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      { agent: "scout", task: "Find things" },
      agentDef,
      { index: 0, runId: "testrun-no-reasoning", recursionDepth: 0 },
    );

    expect(result.exitCode).toBe(0);
    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs).not.toContain("--thinking");
  });

  test("should split only the first slash so provider-prefixed model ids keep the rest as model id", async () => {
    const tempDir = makeTempDir("collab-subagent-model-nested");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      model: "openrouter/openai/gpt-4o",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      { agent: "scout", task: "Find things" },
      agentDef,
      { index: 0, runId: "testrun-model-nested", recursionDepth: 0 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.resolvedModel).toBe("openrouter/openai/gpt-4o");
    expect(result.warnings).toBeUndefined();

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs).not.toContain("--models");
    const providerIdx = capturedArgs.indexOf("--provider");
    const modelIdx = capturedArgs.indexOf("--model");
    expect(capturedArgs[providerIdx + 1]).toBe("openrouter");
    expect(capturedArgs[modelIdx + 1]).toBe("openai/gpt-4o");
  });

  test("should treat a bare model id as legacy: emit --model only and add a provider-inference warning", async () => {
    const tempDir = makeTempDir("collab-subagent-model-bare");
    const { argsFile } = writeFakePiBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;

    const agentDef: SpawnAgentDefinition = {
      name: "scout",
      description: "Scout",
      model: "claude-opus-4.7",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/scout.toml",
      tools: ["read"],
    };

    const result = await runSpawnTask(
      tempDir,
      { agent: "scout", task: "Find things" },
      agentDef,
      { index: 0, runId: "testrun-model-bare", recursionDepth: 0 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.resolvedModel).toBe("claude-opus-4.7");

    const capturedArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    expect(capturedArgs).not.toContain("--models");
    expect(capturedArgs).not.toContain("--provider");
    const modelIdx = capturedArgs.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[modelIdx + 1]).toBe("claude-opus-4.7");

    expect(result.warnings ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/no explicit provider/i),
      ]),
    );
  });

  test("should use explicit --provider and --model in the herdr pane launch script too", async () => {
    const tempDir = makeTempDir("collab-subagent-model-herdr");
    const { argsFile } = writeFakePiBinary(tempDir);
    const { argsFile: herdrArgsFile } = writeFakeHerdrBinary(tempDir);

    process.env.PATH = `${tempDir}:${process.env.PATH ?? ""}`;
    process.env.TEST_ARGS_FILE = argsFile;
    process.env.TEST_HERDR_ARGS_FILE = herdrArgsFile;
    process.env.TEST_HERDR_SEND_ASYNC = "1";
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "w1:p1";

    const agentDef: SpawnAgentDefinition = {
      name: "worker",
      description: "Worker",
      model: "github-copilot/claude-opus-4.7",
      systemPrompt: "Return concise findings.",
      source: "bundled",
      filePath: "/tmp/worker.toml",
      tools: ["read", "bash"],
    };

    const result = await runSpawnTask(
      tempDir,
      { agent: "worker", task: "Inspect" },
      agentDef,
      { index: 0, runId: "testrun-model-herdr", recursionDepth: 0, launchMode: "herdr-pane" },
    );

    expect(result.exitCode).toBe(0);
    expect(result.launchArgs).toContain("--provider");
    expect(result.launchArgs).toContain("github-copilot");
    expect(result.launchArgs).toContain("--model");
    expect(result.launchArgs).toContain("claude-opus-4.7");
    expect(result.launchArgs).not.toContain("--models");

    const capturedPiArgs = JSON.parse(fs.readFileSync(argsFile, "utf-8")) as string[];
    const providerIdx = capturedPiArgs.indexOf("--provider");
    const modelIdx = capturedPiArgs.indexOf("--model");
    expect(capturedPiArgs[providerIdx + 1]).toBe("github-copilot");
    expect(capturedPiArgs[modelIdx + 1]).toBe("claude-opus-4.7");
    expect(capturedPiArgs).not.toContain("--models");
  }, 10000);
});
