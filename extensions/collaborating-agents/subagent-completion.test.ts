import { describe, expect, test } from "bun:test";
import {
  buildSubagentCompletionMessagePayload,
  collectSpawnResults,
  partitionPendingSubagentCompletionUpdates,
  shouldDeferSubagentCompletionUpdate,
  type PendingSubagentCompletionUpdate,
} from "./subagent-completion.ts";
import type { SpawnResult } from "./subagent-spawn.ts";

function makeSpawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    agent: "worker",
    name: "SwiftTiger-1a2b-ClearWave",
    task: "test",
    exitCode: 0,
    output: "done",
    workingDirectory: process.cwd(),
    launchArgs: ["--mode", "json"],
    launchCommand: "pi --mode json",
    launchPrompt: "Task: test",
    launchEnv: {
      PI_AGENT_NAME: "SwiftTiger-1a2b-ClearWave",
      PI_COLLAB_SUBAGENT_DEPTH: "1",
    },
    ...overrides,
  };
}

describe("subagent completion payload helpers", () => {
  test("collectSpawnResults returns single result when details.result exists", () => {
    const single = makeSpawnResult({ name: "Solo" });
    const results = collectSpawnResults({ result: single });
    expect(results).toEqual([single]);
  });

  test("collectSpawnResults prefers details.results for parallel runs", () => {
    const fallback = makeSpawnResult({ name: "Fallback" });
    const first = makeSpawnResult({ name: "First" });
    const second = makeSpawnResult({ name: "Second" });

    const results = collectSpawnResults({ result: fallback, results: [first, second] });
    expect(results).toEqual([first, second]);
  });

  test("buildSubagentCompletionMessagePayload formats single successful result", () => {
    const single = makeSpawnResult({ name: "SwiftTiger-1a2b-ClearWave", output: "## Summary\nall good" });

    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "fallback" }],
      details: { mode: "subagent", result: single, childRunIds: ["run-single"] },
      isError: false,
    });

    expect(payload.customType).toBe("collab_focus_status");
    expect(payload.content).toContain("Received final results from ClearWave.");
    expect(payload.content).toContain("## Summary\nall good");
    expect(payload.content).toContain('agent_message({ action: "tail", runId: "run-single" })');
    expect(payload.content).toContain('agent_message({ action: "session", runId: "run-single" })');
    expect(payload.display).toBe(true);
    expect(payload.details).toEqual({ mode: "subagent", result: single, childRunIds: ["run-single"] });
  });

  test("buildSubagentCompletionMessagePayload creates a minimal hidden wake token", () => {
    const single = makeSpawnResult({ output: "full completion report" });

    const payload = buildSubagentCompletionMessagePayload(
      {
        content: [{ type: "text", text: "fallback" }],
        details: { mode: "subagent", result: single, childRunIds: ["run-hidden"] },
      },
      { hiddenWake: true },
    );

    expect(payload.display).toBe(false);
    expect(payload.content).toContain("Run ID: run-hidden");
    expect(payload.content).toContain('agent_message({ action: "session", runId: "run-hidden" })');
    expect(payload.content).toContain('agent_message({ action: "tail", runId: "run-hidden" })');
    expect(payload.content).not.toContain("full completion report");
    expect(payload.content).not.toContain("fallback");
    expect(payload.details).toEqual({ mode: "subagent_completion_wake", childRunIds: ["run-hidden"], failed: false });
  });

  test("buildSubagentCompletionMessagePayload includes every run ID in a parallel hidden wake token", () => {
    const payload = buildSubagentCompletionMessagePayload(
      {
        content: [{ type: "text", text: "parallel secret" }],
        details: {
          mode: "subagent",
          results: [makeSpawnResult({ output: "first secret" }), makeSpawnResult({ output: "second secret" })],
          childRunIds: ["run-first", "run-second"],
        },
        isError: true,
      },
      { hiddenWake: true },
    );

    expect(payload.content).toContain("Run IDs: run-first, run-second");
    expect(payload.content).toContain('runId: "run-first"');
    expect(payload.content).toContain('runId: "run-second"');
    expect(payload.content).not.toContain("first secret");
    expect(payload.content).not.toContain("second secret");
    expect(payload.details).toEqual({
      mode: "subagent_completion_wake",
      childRunIds: ["run-first", "run-second"],
      failed: true,
    });
  });

  test("buildSubagentCompletionMessagePayload carries the failure reason in a hidden wake token", () => {
    const failed = makeSpawnResult({
      name: "GoldFalcon-e23f-DawnSparrow",
      exitCode: 1,
      error: "Error: Codex error: The usage limit has been reached",
      output: "secret partial output",
    });

    const payload = buildSubagentCompletionMessagePayload(
      {
        content: [{ type: "text", text: "fallback" }],
        details: { mode: "subagent", result: failed, childRunIds: ["e23f5021-0"] },
        isError: true,
      },
      { hiddenWake: true },
    );

    expect(payload.content).toContain("Subagent completion requires attention.");
    expect(payload.content).toContain("Failure reason:");
    expect(payload.content).toContain("DawnSparrow (e23f5021-0): provider usage limit reached (exit code 1)");
    // The classification must not become a loophole for withheld child text.
    expect(payload.content).not.toContain("secret partial output");
    expect(payload.content).not.toContain("Codex error");
    expect(JSON.stringify(payload.details)).not.toContain("Codex error");
    expect(payload.details).toEqual({
      mode: "subagent_completion_wake",
      childRunIds: ["e23f5021-0"],
      failed: true,
      failureReasons: [
        {
          runId: "e23f5021-0",
          name: "DawnSparrow",
          exitCode: 1,
          reason: "provider usage limit reached (exit code 1)",
        },
      ],
    });
  });

  test("buildSubagentCompletionMessagePayload falls back to the exit code when a failure carries no error text", () => {
    const failed = makeSpawnResult({ exitCode: 137, error: undefined, output: "withheld output" });

    const payload = buildSubagentCompletionMessagePayload(
      {
        content: [{ type: "text", text: "fallback" }],
        details: { mode: "subagent", result: failed, childRunIds: ["run-oom"] },
        isError: true,
      },
      { hiddenWake: true },
    );

    expect(payload.content).toContain("exit code 137");
    expect(payload.content).not.toContain("withheld output");
  });

  test("buildSubagentCompletionMessagePayload uses idle-grace wording for auto-closed panes", () => {
    const single = makeSpawnResult({
      name: "SwiftTiger-1a2b-ClearWave",
      launchMode: "herdr-pane",
      paneClosed: true,
    });

    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "fallback" }],
      details: { mode: "subagent", result: single },
      isError: false,
    });

    expect(payload.content).toContain("subagent pane auto-closed after turn-finished output plus idle grace");
  });

  test("buildSubagentCompletionMessagePayload summarizes parallel failures with per-child hints", () => {
    const ok = makeSpawnResult({ name: "SwiftTiger-1a2b-ClearWave", output: "ok output", exitCode: 0 });
    const failed = makeSpawnResult({
      name: "SwiftTiger-1a2b-BrightRiver",
      output: "bad output",
      exitCode: 1,
      error: "boom",
    });

    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "fallback" }],
      details: { mode: "subagent", results: [ok, failed], childRunIds: ["run-ok", "run-failed"] },
      isError: true,
    });

    expect(payload.content).toContain("Received final results from 2 subagents (1 succeeded, 1 failed).");
    expect(payload.content).toContain("### 1. ClearWave (ok)");
    expect(payload.content).toContain("### 2. BrightRiver (failed)");
    expect(payload.content).toContain("ok output");
    expect(payload.content).toContain("bad output");
    expect(payload.content).toContain('agent_message({ action: "tail", runId: "run-ok" })');
    expect(payload.content).toContain('agent_message({ action: "tail", runId: "run-failed" })');
    expect(payload.content).toContain('agent_message({ action: "sessions" })');
    expect(payload.content).not.toContain('runId: "ClearWave"');
  });

  test("buildSubagentCompletionMessagePayload includes hints for failed single results", () => {
    const failed = makeSpawnResult({
      name: "SwiftTiger-1a2b-BrightRiver",
      output: "bad output",
      exitCode: 1,
      sessionId: "session-failed",
      sessionFile: "/tmp/session-failed.jsonl",
    });

    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "fallback" }],
      details: { mode: "subagent", result: failed, childRunIds: ["run-failed"] },
      isError: true,
    });

    expect(payload.content).toContain("Received an error from BrightRiver.");
    expect(payload.content).toContain('agent_message({ action: "tail", runId: "run-failed" })');
    expect(payload.content).toContain('agent_message({ action: "session", runId: "run-failed" })');
  });
});

describe("subagent completion routing helpers", () => {
  test("shouldDeferSubagentCompletionUpdate only defers when target is different", () => {
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: undefined, activeSessionFile: undefined })).toBe(
      false,
    );
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: "/tmp/a.jsonl", activeSessionFile: "/tmp/a.jsonl" })).toBe(
      false,
    );
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: "/tmp/a.jsonl", activeSessionFile: "/tmp/b.jsonl" })).toBe(
      true,
    );
    expect(shouldDeferSubagentCompletionUpdate({ targetSessionFile: "/tmp/a.jsonl", activeSessionFile: undefined })).toBe(
      true,
    );
  });

  test("partitionPendingSubagentCompletionUpdates separates deliverable and deferred entries", () => {
    const updates: PendingSubagentCompletionUpdate[] = [
      {
        payload: {
          customType: "collab_focus_status",
          content: "for-a",
          display: true,
          details: {},
        },
        targetSessionFile: "/tmp/a.jsonl",
      },
      {
        payload: {
          customType: "collab_focus_status",
          content: "for-b",
          display: true,
          details: {},
        },
        targetSessionFile: "/tmp/b.jsonl",
      },
      {
        payload: {
          customType: "collab_focus_status",
          content: "global",
          display: true,
          details: {},
        },
      },
    ];

    const partitioned = partitionPendingSubagentCompletionUpdates(updates, "/tmp/a.jsonl");

    expect(partitioned.deliverable.map((entry) => entry.payload.content)).toEqual(["for-a", "global"]);
    expect(partitioned.deferred.map((entry) => entry.payload.content)).toEqual(["for-b"]);
  });
});

describe("a parked subagent in the completion payload", () => {
  const parked = makeSpawnResult({
    name: "SwiftTiger-1a2b-CalmMaple",
    launchMode: "herdr-pane",
    awaitingReply: "Which branch should I diff against?",
  });

  test("the hidden wake says it is waiting and gives the reply call", () => {
    const payload = buildSubagentCompletionMessagePayload(
      { content: [{ type: "text", text: "" }], details: { result: parked, childRunIds: ["run-7"] } },
      { hiddenWake: true },
    );

    // A hidden wake withholds output on purpose, so without this the coordinator
    // only hears "completion ready" and re-spawns rather than answering.
    expect(payload.content).toContain("waiting on your answer");
    expect(payload.content).toContain("Which branch should I diff against?");
    expect(payload.content).toContain('agent_message({ action: "reply", runId: "run-7"');
  });

  test("the visible payload offers the reply instead of reporting a finished run", () => {
    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "" }],
      details: { result: parked, childRunIds: ["run-7"] },
    });

    expect(payload.content).toContain("waiting on your answer");
    expect(payload.content).not.toContain("Received final results");
    expect(payload.content).toContain("Answer it instead of re-spawning");
  });

  test("an ordinary completion is untouched", () => {
    const payload = buildSubagentCompletionMessagePayload({
      content: [{ type: "text", text: "" }],
      details: { result: makeSpawnResult(), childRunIds: ["run-8"] },
    });

    expect(payload.content).toContain("Received final results");
    expect(payload.content).not.toContain("waiting on your answer");
  });
});
