import { isPaneLaunchMode } from "./subagent-spawn.js";
import type { SpawnResult } from "./subagent-spawn.js";

export interface SubagentCompletionToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

export interface SubagentCompletionMessagePayload {
  customType: "collab_focus_status";
  content: string;
  display: boolean;
  details: Record<string, unknown>;
}

export interface PendingSubagentCompletionUpdate {
  payload: SubagentCompletionMessagePayload;
  targetSessionFile?: string;
  triggerTurn?: boolean;
}

// A failed subagent's `error` can carry arbitrary child stderr or a pane screen
// grab. The hidden wake withholds that on purpose, so the reason surfaced to the
// parent is a CLASSIFICATION, never the text itself: enough to decide whether a
// retry is meaningful (a provider quota clears on its own; a real failure does
// not), with the detail left in the durable run record.
const FAILURE_CLASSIFIERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /usage limit|rate.?limit|quota|too many requests|\b429\b/i, label: "provider usage limit reached" },
  { pattern: /unauthori[sz]ed|forbidden|authentication|invalid api key|\b401\b|\b403\b/i, label: "provider authentication failed" },
  { pattern: /timed? ?out|timeout|deadline exceeded/i, label: "timed out" },
  { pattern: /not found|unknown model|unsupported model|\b404\b/i, label: "model or endpoint not found" },
];

function classifySpawnFailure(result: SpawnResult): string | undefined {
  const haystack = result.error ?? "";
  if (!haystack.trim()) return undefined;
  return FAILURE_CLASSIFIERS.find(({ pattern }) => pattern.test(haystack))?.label;
}

function describeSpawnFailure(result: SpawnResult): string {
  const classification = classifySpawnFailure(result);
  const exitLabel = `exit code ${result.exitCode}`;
  return classification ? `${classification} (${exitLabel})` : exitLabel;
}

function formatAgentDisplayName(agentName: string): string {
  const callsignMatch = agentName.match(/-([A-Z][a-z]+[A-Z][A-Za-z]+)$/);
  if (callsignMatch?.[1]) return callsignMatch[1];
  return agentName;
}

export function collectSpawnResults(details: Record<string, unknown>): SpawnResult[] {
  const singleResult =
    typeof details.result === "object" && details.result
      ? (details.result as SpawnResult)
      : undefined;

  const parallelResults = Array.isArray(details.results)
    ? (details.results as SpawnResult[])
    : undefined;

  if (parallelResults && parallelResults.length > 0) return parallelResults;
  return singleResult ? [singleResult] : [];
}

function collectChildRunIds(details: Record<string, unknown>): string[] {
  return Array.isArray(details.childRunIds)
    ? details.childRunIds.filter((runId): runId is string => typeof runId === "string" && runId.length > 0)
    : [];
}

function inspectionHintLines(runId: string | undefined): string[] {
  if (!runId) return [];
  return [
    "",
    "Inspection:",
    `- agent_message({ action: "tail", runId: "${runId}" })`,
    `- agent_message({ action: "session", runId: "${runId}" })`,
  ];
}

/**
 * What the parent already knows about a parked child's question when the
 * completion wake is built: `answered` — a reply was delivered after the child
 * parked (the wake would re-ask a settled question); `delivered` — the same text
 * already reached the parent as a direct message (the wake is a duplicate, kept
 * only as the reminder to reply once). Seen 2026-09-28: the child sent its
 * question over the bus, the parent replied within 9 s, and the completion wake
 * for the park arrived 2 s after the reply, so the parent spent a turn deciding
 * whether its reply had registered.
 */
export type QuestionState = "answered" | "delivered" | undefined;

export function normalizeQuestionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

export function buildSubagentCompletionMessagePayload(
  result: SubagentCompletionToolResult,
  options?: { hiddenWake?: boolean; questionState?: (runId: string | undefined, question: string) => QuestionState },
): SubagentCompletionMessagePayload | null {
  const allSpawnResults = collectSpawnResults(result.details);
  const allChildRunIds = collectChildRunIds(result.details);
  const stateOf = (index: number): QuestionState => {
    const question = allSpawnResults[index]?.awaitingReply;
    return question ? options?.questionState?.(allChildRunIds[index], question) : undefined;
  };
  // A parked question the parent has already answered is not news: drop it, and
  // when nothing else happened in this batch, send no wake at all.
  const keep = allSpawnResults.map((_, index) => stateOf(index) !== "answered");
  if (!keep.some(Boolean) && allSpawnResults.length > 0) return null;
  const spawnResults = allSpawnResults.filter((_, index) => keep[index]);
  const childRunIds = allChildRunIds.length === allSpawnResults.length
    ? allChildRunIds.filter((_, index) => keep[index])
    : allChildRunIds;
  const deliveredNote = (index: number): string | undefined =>
    stateOf(allSpawnResults.indexOf(spawnResults[index])) === "delivered"
      ? "(the same question already reached you as a direct message; answer it once with reply)"
      : undefined;

  if (options?.hiddenWake) {
    const runLabel = childRunIds.length === 1 ? "Run ID" : "Run IDs";
    const inspectionLines = childRunIds.flatMap((runId) => [
      `- agent_message({ action: "session", runId: "${runId}" })`,
      `- agent_message({ action: "tail", runId: "${runId}" })`,
    ]);
    if (inspectionLines.length === 0) {
      inspectionLines.push('- agent_message({ action: "sessions" })');
    }

    // A hidden wake withholds subagent output on purpose. A failure reason is
    // not output: without it the parent only learns that something "requires
    // attention" and must spend a tool call to find out whether the run failed
    // on its own merits or on a provider quota, which decides whether retrying
    // is even meaningful.
    const failureReasons = spawnResults
      .map((spawnResult, index) => ({ spawnResult, runId: childRunIds[index] }))
      .filter(({ spawnResult }) => spawnResult.exitCode !== 0 || Boolean(spawnResult.error))
      .map(({ spawnResult, runId }) => ({
        runId,
        name: formatAgentDisplayName(spawnResult.name),
        exitCode: spawnResult.exitCode,
        reason: describeSpawnFailure(spawnResult),
      }));
    const failureLines = failureReasons.map(
      ({ name, runId, reason }) => `- ${name}${runId ? ` (${runId})` : ""}: ${reason}`,
    );

    // A parked child is not a completion. Withholding this would leave the parent
    // reading a question out of a transcript and concluding the run had failed,
    // which is exactly what makes it re-spawn instead of answering.
    const awaiting = spawnResults
      .map((spawnResult, index) => ({ spawnResult, runId: childRunIds[index], note: deliveredNote(index) }))
      .filter(({ spawnResult }) => Boolean(spawnResult.awaitingReply))
      .map(({ spawnResult, runId, note }) => ({
        runId,
        name: formatAgentDisplayName(spawnResult.name),
        question: spawnResult.awaitingReply!,
        ...(note ? { note } : {}),
      }));
    const awaitingLines = awaiting.flatMap(({ name, runId, question, note }) => [
      `- ${name}${runId ? ` (${runId})` : ""} asks: ${question}`,
      ...(note ? [`  ${note}`] : []),
      ...(runId ? [`  agent_message({ action: "reply", runId: "${runId}", message: "..." })`] : []),
    ]);

    return {
      customType: "collab_focus_status",
      content: [
        awaitingLines.length > 0
          ? "A subagent is waiting on your answer; its session is still alive."
          : result.isError
            ? "Subagent completion requires attention."
            : "Subagent completion ready.",
        childRunIds.length > 0 ? `${runLabel}: ${childRunIds.join(", ")}` : undefined,
        ...(awaitingLines.length > 0 ? ["Awaiting a reply:", ...awaitingLines] : []),
        ...(failureLines.length > 0 ? ["Failure reason:", ...failureLines] : []),
        "Inspect the durable run record and transcript:",
        ...inspectionLines,
      ].filter((line): line is string => Boolean(line)).join("\n"),
      display: false,
      details: {
        mode: "subagent_completion_wake",
        childRunIds,
        failed: result.isError === true,
        ...(failureReasons.length > 0 ? { failureReasons } : {}),
        ...(awaiting.length > 0 ? { awaiting } : {}),
      },
    };
  }

  let intro: string;
  let body: string;

  if (spawnResults.length > 1) {
    const successCount = spawnResults.filter((r) => r.exitCode === 0).length;
    intro = result.isError
      ? `Received final results from ${spawnResults.length} subagents (${successCount} succeeded, ${spawnResults.length - successCount} failed).`
      : `Received final results from ${spawnResults.length} subagents.`;

    const sections = spawnResults.map((r, index) => {
      const displayName = formatAgentDisplayName(r.name);
      const status = r.awaitingReply ? "awaiting reply" : r.exitCode === 0 ? "ok" : "failed";
      const output = (r.output || "(no output)").trim() || "(no output)";
      const runId = childRunIds[index];
      const paneNote = isPaneLaunchMode(r.launchMode)
        ? r.paneClosed
          ? "subagent pane auto-closed after turn-finished output plus idle grace"
          : r.paneCloseError
            ? `subagent pane close note: ${r.paneCloseError}`
            : undefined
        : undefined;
      return [
        `### ${index + 1}. ${displayName} (${status})`,
        runId ? `Run ID: ${runId}` : undefined,
        paneNote ? `- ${paneNote}` : undefined,
        "",
        output,
        r.awaitingReply ? deliveredNote(index) : undefined,
        r.awaitingReply && runId
          ? `Answer it instead of re-spawning:\n- agent_message({ action: "reply", runId: "${runId}", message: "..." })`
          : undefined,
        ...inspectionHintLines(runId),
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    });

    const sessionsHint = 'agent_message({ action: "sessions" })';
    body = [...sections, `Inspect all subagent sessions:\n- ${sessionsHint}`].join("\n\n");
  } else {
    const singleResult = spawnResults[0];
    const runId = childRunIds[0];
    const runtimeLabel = singleResult?.name ? formatAgentDisplayName(singleResult.name) : "the subagent";
    intro = singleResult?.awaitingReply
      ? `${runtimeLabel} is waiting on your answer; its session is still alive.`
      : result.isError
        ? `Received an error from ${runtimeLabel}.`
        : `Received final results from ${runtimeLabel}.`;

    const paneNote = singleResult && isPaneLaunchMode(singleResult.launchMode)
      ? singleResult.paneClosed
        ? "subagent pane auto-closed after turn-finished output plus idle grace"
        : singleResult.paneCloseError
          ? `subagent pane close note: ${singleResult.paneCloseError}`
          : undefined
      : undefined;

    body = [
      paneNote ? `- ${paneNote}` : undefined,
      (singleResult?.output || result.content[0]?.text || "(no output)").trim() || "(no output)",
      singleResult?.awaitingReply ? deliveredNote(0) : undefined,
      singleResult?.awaitingReply && runId
        ? `Answer it instead of re-spawning:\n- agent_message({ action: "reply", runId: "${runId}", message: "..." })`
        : undefined,
      ...inspectionHintLines(runId),
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
  }

  return {
    customType: "collab_focus_status",
    content: `${intro}\n\n${body}`,
    display: true,
    details: result.details,
  };
}

export function shouldDeferSubagentCompletionUpdate(args: {
  targetSessionFile?: string;
  activeSessionFile?: string;
}): boolean {
  if (!args.targetSessionFile) return false;
  if (!args.activeSessionFile) return true;
  return args.targetSessionFile !== args.activeSessionFile;
}

export function partitionPendingSubagentCompletionUpdates(
  pending: PendingSubagentCompletionUpdate[],
  currentSessionFile: string | undefined,
): { deliverable: PendingSubagentCompletionUpdate[]; deferred: PendingSubagentCompletionUpdate[] } {
  const deliverable: PendingSubagentCompletionUpdate[] = [];
  const deferred: PendingSubagentCompletionUpdate[] = [];

  for (const item of pending) {
    if (
      shouldDeferSubagentCompletionUpdate({
        targetSessionFile: item.targetSessionFile,
        activeSessionFile: currentSessionFile,
      })
    ) {
      deferred.push(item);
      continue;
    }

    deliverable.push(item);
  }

  return { deliverable, deferred };
}
