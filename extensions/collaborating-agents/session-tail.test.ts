import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractAssistantText,
  formatSessionTail,
  parseSessionJsonlLine,
  readSessionTail,
  TAIL_HARD_CAP_BYTES,
} from "./session-tail.ts";

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-session-tail-"));
  return path.join(dir, name);
}

describe("session tail parsing", () => {
  test("extractAssistantText joins text content and ignores non-text content", () => {
    expect(
      extractAssistantText([
        { type: "text", text: "hello" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\nworld");
  });

  test("parses Pi session, assistant, tool call, tool result, and stop events", () => {
    expect(parseSessionJsonlLine(JSON.stringify({ type: "session", id: "session-1", timestamp: "2026-01-01T00:00:00.000Z" }))).toEqual({
      entries: [{ kind: "session", sessionId: "session-1", timestamp: "2026-01-01T00:00:00.000Z" }],
      malformed: false,
    });

    const assistant = parseSessionJsonlLine(
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Use the tool" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
          ],
          stopReason: "toolUse",
        },
      }),
    );
    expect(assistant.entries).toEqual([
      { kind: "assistant_text", text: "Use the tool", timestamp: "2026-01-01T00:00:01.000Z", stopReason: "toolUse" },
      {
        kind: "assistant_tool_call",
        toolCallId: "tool-1",
        toolName: "read",
        argumentsText: "{\"path\":\"README.md\"}",
        timestamp: "2026-01-01T00:00:01.000Z",
        stopReason: "toolUse",
      },
      { kind: "stop", stopReason: "toolUse", timestamp: "2026-01-01T00:00:01.000Z" },
    ]);

    expect(
      parseSessionJsonlLine(
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
          },
        }),
      ).entries,
    ).toEqual([{ kind: "tool_result", toolCallId: "tool-1", toolName: "read", text: "file contents" }]);

    expect(
      parseSessionJsonlLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "final answer" }],
          },
        }),
      ).entries,
    ).toEqual([{ kind: "assistant_text", text: "final answer", stopReason: "message_end" }]);
  });

  test("parses assistant error messages so failed tails show the underlying cause", () => {
    const parsed = parseSessionJsonlLine(
      JSON.stringify({
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "fetch failed",
        },
      }),
    );

    expect(parsed.entries).toEqual([
      {
        kind: "assistant_error",
        errorText: "Error: fetch failed",
        timestamp: "2026-01-01T00:00:02.000Z",
        stopReason: "error",
      },
      { kind: "stop", stopReason: "error", timestamp: "2026-01-01T00:00:02.000Z" },
    ]);
    expect(formatSessionTail(parsed.entries, { runStatus: "failed" })).toBe(
      [
        "[2026-01-01T00:00:02.000Z] assistant error: Error: fetch failed",
        "[2026-01-01T00:00:02.000Z] stop: error",
      ].join("\n"),
    );
  });

  test("tracks line truncation when maxLines drops earlier entries", () => {
    const file = tempFile("session-truncated-lines.jsonl");
    const lines = [
      JSON.stringify({ type: "session", id: "session-2" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "middle" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "latest" }] } }),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");

    const tail = readSessionTail(file, { maxLines: 2 });

    expect(tail.truncatedStart).toBe(false);
    expect(tail.truncatedLineCount).toBe(1);
    expect(tail.malformedLineCount).toBe(0);
    expect(tail.entries).toEqual([
      { kind: "assistant_text", text: "middle", stopReason: "message_end" },
      { kind: "assistant_text", text: "latest", stopReason: "message_end" },
    ]);
  });

  test("returns malformed for invalid json lines", () => {
    expect(parseSessionJsonlLine("{not-json")).toEqual({ entries: [], malformed: true });
  });
});

describe("session tail reading and formatting", () => {
  test("reads bounded suffixes, discards partial first lines, and counts malformed lines", () => {
    const file = tempFile("session.jsonl");
    const lines = [
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: `old-${"x".repeat(200)}` }] } }),
      "{bad",
      JSON.stringify({ type: "session", id: "session-2" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "new" }] } }),
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");

    const tail = readSessionTail(file, { maxBytes: lines.slice(1).join("\n").length + 20, maxLines: 10 });

    expect(tail.truncatedStart).toBe(true);
    expect(tail.malformedLineCount).toBe(1);
    expect(tail.entries).toEqual([
      { kind: "session", sessionId: "session-2" },
      { kind: "assistant_text", text: "new", stopReason: "message_end" },
    ]);
  });

  test("truncates long text and tool outputs safely", () => {
    const line = JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "x".repeat(20) }],
      },
    });

    expect(parseSessionJsonlLine(line, { textLimit: 8 }).entries).toEqual([
      { kind: "tool_result", toolCallId: "tool-1", toolName: "read", text: "xxxxx..." },
    ]);
  });

  test("formats stable concise output and labels only the final assistant response", () => {
    const output = formatSessionTail(
      [
        { kind: "session", sessionId: "session-3" },
        { kind: "assistant_text", text: "first" },
        { kind: "assistant_tool_call", toolCallId: "tool-1", toolName: "read", argumentsText: "{\"path\":\"README.md\"}" },
        { kind: "tool_result", toolCallId: "tool-1", toolName: "read", text: "ok" },
        { kind: "assistant_text", text: "done" },
      ],
      { runStatus: "completed" },
    );

    expect(output).toBe(
      [
        "session session-3",
        "assistant: first",
        "assistant tool call read tool-1: {\"path\":\"README.md\"}",
        "tool result read tool-1: ok",
        "assistant final: done",
      ].join("\n"),
    );
  });

  test("does not label tool-use assistant text as final", () => {
    const output = formatSessionTail(
      [
        { kind: "assistant_text", text: "I will inspect the file", stopReason: "toolUse" },
        { kind: "assistant_tool_call", toolCallId: "tool-1", toolName: "read" },
        { kind: "stop", stopReason: "toolUse" },
      ],
      { runStatus: "failed" },
    );

    expect(output).toBe(
      [
        "assistant: I will inspect the file",
        "assistant tool call read tool-1",
        "stop: toolUse",
      ].join("\n"),
    );
  });

  test("does not label running assistant text as final", () => {
    const output = formatSessionTail(
      [
        { kind: "assistant_text", text: "work in progress" },
      ],
      { runStatus: "running" },
    );

    expect(output).toBe("assistant: work in progress");
  });
});

describe("session tail delta reads and hard cap", () => {
  function writeJsonlLines(file: string, lines: string[]): void {
    fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
  }

  function textLine(text: string): string {
    return JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }

  test("first read returns nextOffset equal to file size and can round-trip to empty delta", () => {
    const file = tempFile("delta-round-trip.jsonl");
    writeJsonlLines(file, [textLine("one"), textLine("two")]);
    const size = fs.statSync(file).size;

    const first = readSessionTail(file);
    expect(first.nextOffset).toBe(size);
    expect(first.resynced).toBe(false);
    expect(first.entries.map((entry) => (entry.kind === "assistant_text" ? entry.text : entry.kind))).toEqual([
      "one",
      "two",
    ]);

    const empty = readSessionTail(file, { sinceOffset: first.nextOffset });
    expect(empty.entries).toEqual([]);
    expect(empty.bytesRead).toBe(0);
    expect(empty.nextOffset).toBe(size);
    expect(empty.resynced).toBe(false);
    expect(empty.truncatedStart).toBe(false);
  });

  test("delta read returns only new bytes appended after sinceOffset", () => {
    const file = tempFile("delta-only-new.jsonl");
    writeJsonlLines(file, [textLine("first")]);
    const firstOffset = fs.statSync(file).size;

    fs.appendFileSync(file, `${textLine("second")}\n`, "utf-8");
    const secondOffset = fs.statSync(file).size;

    const delta = readSessionTail(file, { sinceOffset: firstOffset });

    expect(delta.nextOffset).toBe(secondOffset);
    expect(delta.resynced).toBe(false);
    expect(delta.truncatedStart).toBe(false);
    expect(delta.entries).toEqual([
      { kind: "assistant_text", text: "second", stopReason: "message_end" },
    ]);
  });

  test("stale sinceOffset (greater than current file size) resyncs from end", () => {
    const file = tempFile("delta-stale.jsonl");
    writeJsonlLines(file, [textLine("only")]);
    const size = fs.statSync(file).size;

    const result = readSessionTail(file, { sinceOffset: size + 5_000 });

    expect(result.resynced).toBe(true);
    expect(result.nextOffset).toBe(size);
    expect(result.entries).toEqual([
      { kind: "assistant_text", text: "only", stopReason: "message_end" },
    ]);
  });

  test("negative or non-integer sinceOffset resyncs from end", () => {
    const file = tempFile("delta-invalid.jsonl");
    writeJsonlLines(file, [textLine("payload")]);

    const negative = readSessionTail(file, { sinceOffset: -1 });
    expect(negative.resynced).toBe(true);
    expect(negative.entries).toEqual([
      { kind: "assistant_text", text: "payload", stopReason: "message_end" },
    ]);

    const fractional = readSessionTail(file, { sinceOffset: 2.5 });
    expect(fractional.resynced).toBe(true);
    expect(fractional.entries).toEqual([
      { kind: "assistant_text", text: "payload", stopReason: "message_end" },
    ]);
  });

  test("sinceOffset landing mid-line drops the partial first line but keeps subsequent JSONL parseable", () => {
    const file = tempFile("delta-partial-line.jsonl");
    const lineA = textLine("alpha-line-with-enough-bytes-to-split-here");
    const lineB = textLine("beta");
    writeJsonlLines(file, [lineA, lineB]);

    // Point sinceOffset into the middle of the first JSONL line so the delta
    // read has to skip a partial line before parsing.
    const midOfFirstLine = Math.floor(lineA.length / 2);

    const result = readSessionTail(file, { sinceOffset: midOfFirstLine });

    expect(result.resynced).toBe(false);
    expect(result.truncatedStart).toBe(true);
    expect(result.malformedLineCount).toBe(0);
    expect(result.entries).toEqual([
      { kind: "assistant_text", text: "beta", stopReason: "message_end" },
    ]);
  });

  test("tail-from-end is clamped to the hard cap even when maxBytes is huge", () => {
    const file = tempFile("hard-cap-tail.jsonl");
    // Produce a payload far larger than TAIL_HARD_CAP_BYTES.
    const bulkLines = Array.from({ length: 200 }, (_v, index) => textLine(`bulk-${index}-${"x".repeat(80)}`));
    writeJsonlLines(file, bulkLines);

    const result = readSessionTail(file, { maxBytes: 10 * 1024 * 1024 });

    // Even if the caller asks for 10 MB, at most TAIL_HARD_CAP_BYTES are read.
    expect(result.bytesRead).toBeLessThanOrEqual(TAIL_HARD_CAP_BYTES);
    expect(result.truncatedStart).toBe(true);
    expect(result.nextOffset).toBe(fs.statSync(file).size);
  });

  test("delta reads are also clamped to the hard cap when the gap exceeds it", () => {
    const file = tempFile("hard-cap-delta.jsonl");
    writeJsonlLines(file, [textLine("seed")]);
    const seedOffset = fs.statSync(file).size;

    // Append well over TAIL_HARD_CAP_BYTES worth of new lines.
    const extra = Array.from({ length: 200 }, (_v, index) => textLine(`extra-${index}-${"y".repeat(80)}`));
    fs.appendFileSync(file, `${extra.join("\n")}\n`, "utf-8");
    const finalSize = fs.statSync(file).size;

    const result = readSessionTail(file, { sinceOffset: seedOffset });

    expect(result.bytesRead).toBeLessThanOrEqual(TAIL_HARD_CAP_BYTES);
    expect(result.truncatedStart).toBe(true);
    expect(result.resynced).toBe(false);
    expect(result.nextOffset).toBe(finalSize);
  });
});

