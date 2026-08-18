import { describe, expect, test } from "bun:test";
import {
  deriveHerdrWorkspaceId,
  herdrCallerPaneFromEnv,
  isInsideHerdrPane,
  parseHerdrAck,
  parseHerdrEnvelope,
  parseHerdrPane,
} from "./herdr.ts";

const PANE_SPLIT_STDOUT = JSON.stringify({
  id: "cli:pane:split",
  result: {
    pane: {
      agent_status: "unknown",
      cwd: "/private/tmp",
      focused: false,
      pane_id: "w1:p2",
      tab_id: "w1:t1",
      terminal_id: "term_65951aef51cd02",
      workspace_id: "w1",
    },
    type: "pane_info",
  },
});

function output(stdout: string, exitCode = 0, stderr = ""): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode, stdout, stderr };
}

describe("herdr envelope parsing", () => {
  test("unwraps a successful result payload", () => {
    const envelope = parseHerdrEnvelope(output(PANE_SPLIT_STDOUT));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.value.type).toBe("pane_info");
  });

  test("surfaces the error code and message from an error envelope", () => {
    const stdout = JSON.stringify({
      error: { code: "pane_not_found", message: "pane --pane not found" },
      id: "cli:request",
    });
    const envelope = parseHerdrEnvelope(output(stdout));
    expect(envelope).toEqual({ ok: false, error: "pane_not_found: pane --pane not found" });
  });

  // herdr reports failures in the JSON body while still exiting non-zero, so the
  // body has to win over the exit code or every error degrades to "exit 1".
  test("prefers the error body over a non-zero exit code", () => {
    const stdout = JSON.stringify({ error: { code: "pane_not_found" }, id: "cli:request" });
    const envelope = parseHerdrEnvelope(output(stdout, 1, "herdr: request failed"));
    expect(envelope).toEqual({ ok: false, error: "pane_not_found" });
  });

  // Errors arrive on stderr, not stdout, so an envelope search that only looked
  // at stdout would report every failure as unparseable output.
  test("finds the error envelope on stderr", () => {
    const stderr = JSON.stringify({ error: { code: "pane_not_found", message: "pane not found" }, id: "cli:pane:split" });
    expect(parseHerdrEnvelope(output("", 1, stderr))).toEqual({
      ok: false,
      error: "pane_not_found: pane not found",
    });
  });

  test("falls back to stderr when nothing parses", () => {
    const envelope = parseHerdrEnvelope(output("not json at all", 127, "herdr: command not found"));
    expect(envelope).toEqual({ ok: false, error: "herdr: command not found" });
  });

  test("reports a clear error when the command produced nothing", () => {
    const envelope = parseHerdrEnvelope(output("", 0, ""));
    expect(envelope).toEqual({ ok: false, error: "herdr produced no parseable output" });
  });

  test("recovers the envelope from a trailing line when output carries a banner", () => {
    const envelope = parseHerdrEnvelope(output(`Restored session: Tue 18 Aug\n${PANE_SPLIT_STDOUT}`));
    expect(envelope.ok).toBe(true);
  });

  test("treats a result that is not an object as a failure", () => {
    const envelope = parseHerdrEnvelope(output(JSON.stringify({ id: "cli:x", result: "ok" })));
    expect(envelope.ok).toBe(false);
  });
});

describe("herdr acknowledgement parsing", () => {
  // send-text and send-keys print nothing at all when they succeed, so silence
  // plus a zero exit has to count as success or every launch fails.
  test("treats silent success as success", () => {
    expect(parseHerdrAck(output("", 0, ""))).toEqual({ ok: true, value: true });
  });

  test("still unwraps an envelope when one is present", () => {
    const stdout = JSON.stringify({ id: "cli:pane:close", result: { type: "ok" } });
    expect(parseHerdrAck(output(stdout))).toEqual({ ok: true, value: true });
  });

  test("fails on an error envelope even with a zero exit", () => {
    const stderr = JSON.stringify({ error: { code: "pane_not_found", message: "pane not found" } });
    expect(parseHerdrAck(output("", 0, stderr))).toEqual({
      ok: false,
      error: "pane_not_found: pane not found",
    });
  });

  test("fails on a non-zero exit with no parseable body", () => {
    expect(parseHerdrAck(output("", 3, ""))).toEqual({ ok: false, error: "herdr exited with code 3" });
  });
});

describe("herdr pane parsing", () => {
  test("reads pane, workspace and tab ids", () => {
    const parsed = parseHerdrEnvelope(output(PANE_SPLIT_STDOUT));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parseHerdrPane(parsed.value.pane)).toEqual({
      paneId: "w1:p2",
      workspaceId: "w1",
      tabId: "w1:t1",
    });
  });

  test("derives the workspace when the payload omits it", () => {
    expect(parseHerdrPane({ pane_id: "w3:p9" })).toEqual({
      paneId: "w3:p9",
      workspaceId: "w3",
      tabId: undefined,
    });
  });

  test("rejects payloads without a pane id", () => {
    expect(parseHerdrPane({ workspace_id: "w1" })).toBeNull();
    expect(parseHerdrPane(null)).toBeNull();
    expect(parseHerdrPane([{ pane_id: "w1:p1" }])).toBeNull();
  });

  test("deriveHerdrWorkspaceId tolerates an id without a separator", () => {
    expect(deriveHerdrWorkspaceId("w1:p2")).toBe("w1");
    expect(deriveHerdrWorkspaceId("solo")).toBe("solo");
  });
});

describe("herdr activation contract", () => {
  test("recognises a pane launched by herdr", () => {
    const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p3" };
    expect(isInsideHerdrPane(env)).toBe(true);
    expect(herdrCallerPaneFromEnv(env)).toEqual({ paneId: "w1:p3", workspaceId: "w1" });
  });

  test("rejects a shell that herdr did not launch", () => {
    expect(isInsideHerdrPane({})).toBe(false);
    expect(isInsideHerdrPane({ HERDR_ENV: "1" })).toBe(false);
    expect(isInsideHerdrPane({ HERDR_PANE_ID: "w1:p3" })).toBe(false);
    expect(isInsideHerdrPane({ HERDR_ENV: "1", HERDR_PANE_ID: "   " })).toBe(false);
    expect(herdrCallerPaneFromEnv({})).toBeNull();
  });
});
