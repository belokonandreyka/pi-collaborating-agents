import { spawn } from "node:child_process";

/**
 * Thin adapter over the `herdr` CLI (https://herdr.dev).
 *
 * Two differences from the cmux adapter shape the code below. First, herdr
 * answers every command with a JSON envelope on stdout, so no output scraping
 * is needed. Second, its hierarchy is workspace -> tab -> pane with no surface
 * layer, so a pane id is a subagent's whole identity; callers that also drive
 * cmux map both `paneRef` and `surfaceRef` onto that single id.
 */

export interface HerdrPane {
  paneId: string;
  workspaceId: string;
  tabId?: string;
}

export type HerdrSplitDirection = "right" | "down";

export type HerdrResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface HerdrCommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const HERDR_BIN = "herdr";

function truncateForError(value: string, limit = 200): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}...`;
}

async function runHerdrCommand(args: string[]): Promise<HerdrCommandOutput> {
  return await new Promise((resolve) => {
    const proc = spawn(HERDR_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ exitCode: 1, stdout: "", stderr: message });
    });
  });
}

/**
 * Success bodies arrive on stdout, failures on stderr, so both streams have to
 * be searched before a verdict is reached.
 */
function findHerdrEnvelope(output: HerdrCommandOutput): Record<string, unknown> | null {
  return parseJsonEnvelope(output.stdout) ?? parseJsonEnvelope(output.stderr);
}

function extractHerdrError(parsed: Record<string, unknown>): string | null {
  const errorValue = parsed.error;
  if (!errorValue || typeof errorValue !== "object") return null;

  const errorRecord = errorValue as Record<string, unknown>;
  const code = typeof errorRecord.code === "string" ? errorRecord.code : "herdr_error";
  const message = typeof errorRecord.message === "string" ? errorRecord.message : "";
  return message ? `${code}: ${message}` : code;
}

/**
 * Unwraps herdr's `{"id":...,"result":{...}}` / `{"error":{"code","message"}}`
 * envelope. A failing command still carries a JSON error body, so the envelope
 * is parsed before the exit code is trusted — its `code` is far more useful
 * than "exit 1".
 */
export function parseHerdrEnvelope(output: HerdrCommandOutput): HerdrResult<Record<string, unknown>> {
  const parsed = findHerdrEnvelope(output);

  if (!parsed) {
    const fallback = output.stderr || output.stdout;
    return {
      ok: false,
      error: fallback ? truncateForError(fallback) : "herdr produced no parseable output",
    };
  }

  const error = extractHerdrError(parsed);
  if (error) return { ok: false, error };

  const resultValue = parsed.result;
  if (!resultValue || typeof resultValue !== "object" || Array.isArray(resultValue)) {
    if (output.exitCode !== 0) {
      const fallback = output.stderr || output.stdout;
      return { ok: false, error: fallback ? truncateForError(fallback) : `herdr exited with code ${output.exitCode}` };
    }
    return { ok: false, error: `Unexpected herdr response: ${truncateForError(output.stdout || "(empty)")}` };
  }

  return { ok: true, value: resultValue as Record<string, unknown> };
}

/**
 * Verdict for commands that answer with nothing at all on success — `send-text`
 * and `send-keys` print no envelope, so silence plus a zero exit is the only
 * available success signal.
 */
export function parseHerdrAck(output: HerdrCommandOutput): HerdrResult<true> {
  const parsed = findHerdrEnvelope(output);
  if (parsed) {
    const error = extractHerdrError(parsed);
    if (error) return { ok: false, error };
  }

  if (output.exitCode !== 0) {
    const fallback = output.stderr || output.stdout;
    return {
      ok: false,
      error: fallback ? truncateForError(fallback) : `herdr exited with code ${output.exitCode}`,
    };
  }

  return { ok: true, value: true };
}

/**
 * Tolerates a leading banner or trailing noise around the JSON body by falling
 * back to the last brace-delimited line.
 */
function parseJsonEnvelope(stdout: string): Record<string, unknown> | null {
  const direct = tryParseObject(stdout);
  if (direct) return direct;

  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"));

  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(lines[i]);
    if (parsed) return parsed;
  }

  return null;
}

function tryParseObject(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Pane ids are `<workspace>:<pane>`, so the workspace is recoverable offline. */
export function deriveHerdrWorkspaceId(paneId: string): string {
  const separatorIndex = paneId.indexOf(":");
  return separatorIndex > 0 ? paneId.slice(0, separatorIndex) : paneId;
}

export function parseHerdrPane(value: unknown): HerdrPane | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const paneId = typeof record.pane_id === "string" && record.pane_id.length > 0 ? record.pane_id : null;
  if (!paneId) return null;

  const workspaceId =
    typeof record.workspace_id === "string" && record.workspace_id.length > 0
      ? record.workspace_id
      : deriveHerdrWorkspaceId(paneId);
  const tabId = typeof record.tab_id === "string" && record.tab_id.length > 0 ? record.tab_id : undefined;

  return { paneId, workspaceId, tabId };
}

/**
 * Herdr exports these into every pane it launches, which is both the extension's
 * activation contract and a cheaper caller lookup than `herdr pane current`.
 */
export function isInsideHerdrPane(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.HERDR_ENV === "1" && typeof source.HERDR_PANE_ID === "string" && source.HERDR_PANE_ID.trim().length > 0;
}

export function herdrCallerPaneFromEnv(source: NodeJS.ProcessEnv = process.env): HerdrPane | null {
  if (!isInsideHerdrPane(source)) return null;
  const paneId = source.HERDR_PANE_ID!.trim();
  return { paneId, workspaceId: deriveHerdrWorkspaceId(paneId) };
}

export async function herdrListPanes(workspaceId?: string): Promise<HerdrResult<HerdrPane[]>> {
  const args = workspaceId ? ["pane", "list", "--workspace", workspaceId] : ["pane", "list"];
  const envelope = parseHerdrEnvelope(await runHerdrCommand(args));
  if (!envelope.ok) return envelope;

  const rawPanes = envelope.value.panes;
  if (!Array.isArray(rawPanes)) return { ok: false, error: "herdr pane list returned no panes array" };

  const panes: HerdrPane[] = [];
  for (const raw of rawPanes) {
    const pane = parseHerdrPane(raw);
    if (pane) panes.push(pane);
  }

  return { ok: true, value: panes };
}

export async function herdrSplitPane(args: {
  paneId: string;
  direction: HerdrSplitDirection;
  cwd?: string;
  env?: Record<string, string>;
}): Promise<HerdrResult<HerdrPane>> {
  const commandArgs = ["pane", "split", "--pane", args.paneId, "--direction", args.direction];
  if (args.cwd) commandArgs.push("--cwd", args.cwd);
  for (const [key, value] of Object.entries(args.env ?? {})) {
    commandArgs.push("--env", `${key}=${value}`);
  }

  const envelope = parseHerdrEnvelope(await runHerdrCommand(commandArgs));
  if (!envelope.ok) return envelope;

  const pane = parseHerdrPane(envelope.value.pane);
  return pane ? { ok: true, value: pane } : { ok: false, error: "herdr pane split returned no pane" };
}

/**
 * Types a line into the pane's shell. `send-text` alone leaves the line
 * unsubmitted, so the Enter key press is part of the same operation.
 */
export async function herdrSendLine(paneId: string, text: string): Promise<HerdrResult<true>> {
  const sendText = parseHerdrAck(await runHerdrCommand(["pane", "send-text", paneId, text]));
  if (!sendText.ok) return sendText;

  return parseHerdrAck(await runHerdrCommand(["pane", "send-keys", paneId, "Enter"]));
}

export async function herdrClosePane(paneId: string): Promise<HerdrResult<true>> {
  return parseHerdrAck(await runHerdrCommand(["pane", "close", paneId]));
}

/**
 * Reads back a pane's terminal contents for diagnostics. Unlike the other
 * commands this one emits raw text rather than a JSON envelope, and it is only
 * ever used to enrich an error message, so failures degrade to an empty string.
 */
export async function herdrReadPane(paneId: string, lines?: number): Promise<string> {
  const args = ["pane", "read", paneId];
  if (typeof lines === "number" && Number.isFinite(lines) && lines > 0) {
    args.push("--lines", String(Math.floor(lines)));
  }

  const output = await runHerdrCommand(args);
  if (output.exitCode !== 0) return "";
  if (output.stdout.trim().startsWith("{")) return "";
  return output.stdout;
}
