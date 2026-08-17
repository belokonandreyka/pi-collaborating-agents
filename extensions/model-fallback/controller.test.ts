import { describe, expect, test } from "bun:test";
import {
  FallbackController,
  formatTokens,
  type ContinuationPayload,
  type ControllerDeps,
  type ControllerModelRef,
  type ResolvedModel,
} from "./controller.ts";
import { DEFAULT_CONFIG, type ChainEntry, type ModelFallbackConfig } from "./config.ts";

interface Harness {
  controller: FallbackController;
  notifications: Array<{ level: string; message: string }>;
  continuations: ContinuationPayload[];
  setModelCalls: ResolvedModel[];
  findCalls: ChainEntry[];
  /** Interleaved log of notify/continuation calls, for ordering assertions. */
  callOrder: string[];
  contextTokensCalls: number;
}

interface HarnessOverrides {
  config?: Partial<ModelFallbackConfig>;
  current?: ControllerModelRef | undefined;
  registered?: Record<string, boolean>;
  authorized?: Record<string, boolean>;
  getContextTokens?: () => number | undefined;
}

function key(entry: ChainEntry | ControllerModelRef): string {
  return `${entry.provider}/${entry.id}`.toLowerCase();
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const config: ModelFallbackConfig = {
    ...DEFAULT_CONFIG,
    enabled: true,
    notifyUser: true,
    resumeText: "resume-please",
    chain: [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "github-copilot", id: "claude-opus-4.7" },
      { provider: "openai-codex", id: "gpt-5.6-sol" },
    ],
    ...(overrides.config ?? {}),
  };

  const registered = overrides.registered ?? {
    "anthropic/claude-opus-4-8": true,
    "github-copilot/claude-opus-4.7": true,
    "openai-codex/gpt-5.6-sol": true,
  };
  const authorized = overrides.authorized ?? {};

  const state = {
    current: overrides.current ?? { provider: "anthropic", id: "claude-opus-4-8" },
  };

  const notifications: Array<{ level: string; message: string }> = [];
  const continuations: ContinuationPayload[] = [];
  const setModelCalls: ResolvedModel[] = [];
  const findCalls: ChainEntry[] = [];
  const callOrder: string[] = [];
  const counters = { contextTokens: 0 };

  const deps: ControllerDeps = {
    config,
    getCurrentModel: () => state.current,
    findModel: (entry: ChainEntry) => {
      findCalls.push(entry);
      if (!registered[key(entry)]) return undefined;
      return { provider: entry.provider, id: entry.id, raw: { provider: entry.provider, id: entry.id } };
    },
    setModel: async (model: ResolvedModel) => {
      setModelCalls.push(model);
      const authKey = key(model);
      const isAuthorized = authorized[authKey] !== false;
      if (!isAuthorized) return false;
      state.current = { provider: model.provider, id: model.id };
      return true;
    },
    sendContinuation: async (payload) => {
      continuations.push(payload);
      callOrder.push("continuation");
    },
    notify: (message, level) => {
      notifications.push({ message, level });
      callOrder.push(`notify:${level}`);
    },
    getContextTokens: () => {
      counters.contextTokens++;
      return overrides.getContextTokens?.();
    },
  };

  const harness: Harness = {
    controller: new FallbackController(deps),
    notifications,
    continuations,
    setModelCalls,
    findCalls,
    callOrder,
    get contextTokensCalls() {
      return counters.contextTokens;
    },
  };
  return harness;
}

describe("FallbackController", () => {
  test("should do nothing when disabled", async () => {
    const harness = makeHarness({ config: { enabled: false } });
    harness.controller.onProviderResponse(429);
    const outcome = await harness.controller.handleSettled();
    expect(outcome).toEqual({ kind: "noop", reason: "disabled" });
    expect(harness.setModelCalls).toEqual([]);
    expect(harness.continuations).toEqual([]);
  });

  test("should do nothing when settled without an eligible error", async () => {
    const harness = makeHarness();
    const outcome = await harness.controller.handleSettled();
    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
  });

  test("should skip when current model is not in the chain", async () => {
    const harness = makeHarness({ current: { provider: "anthropic", id: "not-in-chain" } });
    harness.controller.onProviderResponse(429);
    const outcome = await harness.controller.handleSettled();
    expect(outcome).toEqual({ kind: "not-in-chain" });
    expect(harness.setModelCalls).toEqual([]);
  });

  test("should advance to the next chain entry, send continuation once, and clear pending error", async () => {
    const harness = makeHarness();
    harness.controller.onProviderResponse(429);
    harness.controller.onAssistantMessage("error", "rate limit hit");

    const outcome = await harness.controller.handleSettled();
    expect(outcome.kind).toBe("switched");
    if (outcome.kind === "switched") {
      expect(outcome.to).toEqual({ provider: "github-copilot", id: "claude-opus-4.7" });
      expect(outcome.trigger).toBe("error");
    }
    expect(harness.setModelCalls.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "github-copilot/claude-opus-4.7",
    ]);
    expect(harness.continuations).toHaveLength(1);
    expect(harness.continuations[0]!.previousModel).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-8",
    });
    expect(harness.continuations[0]!.nextModel).toEqual({
      provider: "github-copilot",
      id: "claude-opus-4.7",
    });
    expect(harness.continuations[0]!.resumeText).toBe("resume-please");

    const secondOutcome = await harness.controller.handleSettled();
    expect(secondOutcome).toEqual({ kind: "noop", reason: "no_error" });
  });

  test("should skip unregistered and unauthorized entries and pick the next available model", async () => {
    const harness = makeHarness({
      registered: {
        "anthropic/claude-opus-4-8": true,
        "github-copilot/claude-opus-4.7": false,
        "openai-codex/gpt-5.6-sol": true,
      },
      authorized: { "openai-codex/gpt-5.6-sol": true },
    });
    harness.controller.onProviderResponse(429);

    const outcome = await harness.controller.handleSettled();
    expect(outcome.kind).toBe("switched");
    if (outcome.kind === "switched") {
      expect(outcome.to).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    }
    expect(harness.continuations).toHaveLength(1);
    expect(harness.notifications.some((n) => n.message.includes("github-copilot"))).toBe(true);
  });

  test("should advance further after a fallback model itself errors on a later settle", async () => {
    const harness = makeHarness();
    harness.controller.onProviderResponse(429);
    await harness.controller.handleSettled();

    harness.controller.onProviderResponse(undefined);
    harness.controller.onAssistantMessage("error", "quota exhausted again");
    const outcome = await harness.controller.handleSettled();
    expect(outcome.kind).toBe("switched");
    if (outcome.kind === "switched") {
      expect(outcome.to).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    }
    expect(harness.continuations).toHaveLength(2);
  });

  test("should not cycle after chain exhaustion and notify once", async () => {
    const harness = makeHarness({
      current: { provider: "openai-codex", id: "gpt-5.6-sol" },
    });
    harness.controller.onProviderResponse(429);
    const first = await harness.controller.handleSettled();
    expect(first).toEqual({ kind: "chain-exhausted" });
    expect(harness.setModelCalls).toEqual([]);

    harness.controller.onProviderResponse(429);
    const second = await harness.controller.handleSettled();
    expect(second).toEqual({ kind: "chain-exhausted" });
    const exhaustionNotices = harness.notifications.filter((n) =>
      n.message.includes("chain exhausted"),
    );
    expect(exhaustionNotices).toHaveLength(1);
  });

  test("should not fall back for context overflow or auth errors", async () => {
    const overflow = makeHarness();
    overflow.controller.onAssistantMessage("error", "context window exceeded");
    const outcome1 = await overflow.controller.handleSettled();
    expect(outcome1).toEqual({ kind: "not-eligible", reason: "context_overflow" });
    expect(overflow.setModelCalls).toEqual([]);

    const auth = makeHarness();
    auth.controller.onProviderResponse(401);
    const outcome2 = await auth.controller.handleSettled();
    expect(outcome2.kind).toBe("not-eligible");
  });

  test("should clear pending error state after a successful assistant message", async () => {
    const harness = makeHarness();
    harness.controller.onProviderResponse(429);
    harness.controller.onAssistantMessage("error", "rate limit");
    harness.controller.onAssistantMessage("stop", undefined);

    const outcome = await harness.controller.handleSettled();
    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.setModelCalls).toEqual([]);
  });

  test("should treat provider/model matching case-insensitively when finding position in chain", async () => {
    const harness = makeHarness({
      current: { provider: "Anthropic", id: "Claude-Opus-4-8" },
    });
    harness.controller.onProviderResponse(429);
    const outcome = await harness.controller.handleSettled();
    expect(outcome.kind).toBe("switched");
  });

  test("should emit a red paid notice when switching onto a paid entry", async () => {
    const harness = makeHarness({
      current: { provider: "github-copilot", id: "claude-opus-4.7" },
      config: {
        chain: [
          { provider: "github-copilot", id: "claude-opus-4.7" },
          { provider: "openrouter", id: "google/gemini-3.7-flash" },
        ],
        paidEntries: [{ provider: "openrouter", id: "google/gemini-3.7-flash" }],
        paidNoticeText: "ALL LIMITS EXHAUSTED",
      },
      registered: { "openrouter/google/gemini-3.7-flash": true },
    });

    harness.controller.onProviderResponse(429);
    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    const paid = harness.notifications.filter((n) => n.level === "error");
    expect(paid).toHaveLength(1);
    expect(paid[0]!.message).toBe(
      "ALL LIMITS EXHAUSTED (openrouter/google/gemini-3.7-flash)",
    );
  });

  test("should not emit a paid notice when the target entry is free", async () => {
    const harness = makeHarness({
      config: {
        paidEntries: [{ provider: "openrouter", id: "google/gemini-3.7-flash" }],
      },
    });

    harness.controller.onProviderResponse(429);
    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    expect(harness.notifications.filter((n) => n.level === "error")).toEqual([]);
  });

  test("should still warn about billing when routine switch chatter is muted", async () => {
    const harness = makeHarness({
      current: { provider: "github-copilot", id: "claude-opus-4.7" },
      config: {
        notifyUser: false,
        chain: [
          { provider: "github-copilot", id: "claude-opus-4.7" },
          { provider: "openrouter", id: "google/gemini-3.7-flash" },
        ],
        paidEntries: [{ provider: "openrouter", id: "google/gemini-3.7-flash" }],
        paidNoticeText: "ALL LIMITS EXHAUSTED",
      },
      registered: { "openrouter/google/gemini-3.7-flash": true },
    });

    harness.controller.onProviderResponse(429);
    await harness.controller.handleSettled();

    // notifyUser=false silences the "switched to ..." info line but must not
    // silence the billing warning.
    expect(harness.notifications.filter((n) => n.level === "info")).toEqual([]);
    expect(harness.notifications.filter((n) => n.level === "error")).toHaveLength(1);
  });
});

describe("FallbackController context warnings", () => {
  const CONTEXT_WARNING = {
    entry: { provider: "openai-codex", id: "gpt-5.6-sol" },
    aboveTokens: 270000,
    text: "context hazard",
  };

  function makeContextHarness(overrides: HarnessOverrides = {}): Harness {
    return makeHarness({
      current: { provider: "github-copilot", id: "claude-opus-4.7" },
      getContextTokens: () => 330000,
      ...overrides,
      config: {
        chain: [
          { provider: "github-copilot", id: "claude-opus-4.7" },
          { provider: "openai-codex", id: "gpt-5.6-sol" },
        ],
        contextWarnings: [CONTEXT_WARNING],
        ...(overrides.config ?? {}),
      },
    });
  }

  function warnings(harness: Harness): string[] {
    return harness.notifications.filter((n) => n.level === "warning").map((n) => n.message);
  }

  test("should warn when the context exceeds the target entry's threshold", async () => {
    const harness = makeContextHarness();
    harness.controller.onProviderResponse(429);

    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    expect(warnings(harness)).toEqual([
      "context hazard (openai-codex/gpt-5.6-sol: context ~330k > 270k)",
    ]);
  });

  test("should stay silent when Pi cannot report a trustworthy context size", async () => {
    const harness = makeContextHarness({ getContextTokens: () => undefined });
    harness.controller.onProviderResponse(429);

    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    expect(warnings(harness)).toEqual([]);
  });

  test("should not warn when the context is exactly at the threshold", async () => {
    const harness = makeContextHarness({ getContextTokens: () => 270000 });
    harness.controller.onProviderResponse(429);

    await harness.controller.handleSettled();

    expect(warnings(harness)).toEqual([]);
  });

  test("should not warn when the context is below the threshold", async () => {
    const harness = makeContextHarness({ getContextTokens: () => 269999 });
    harness.controller.onProviderResponse(429);

    await harness.controller.handleSettled();

    expect(warnings(harness)).toEqual([]);
  });

  test("should warn one token above the threshold", async () => {
    const harness = makeContextHarness({ getContextTokens: () => 270001 });
    harness.controller.onProviderResponse(429);

    await harness.controller.handleSettled();

    expect(warnings(harness)).toEqual([
      "context hazard (openai-codex/gpt-5.6-sol: context ~270k > 270k)",
    ]);
  });

  test("should not warn when no warning is configured for the target entry", async () => {
    const harness = makeContextHarness({
      getContextTokens: () => 900000,
      config: {
        contextWarnings: [
          {
            entry: { provider: "openrouter", id: "google/gemini-3.7-flash" },
            aboveTokens: 10,
            text: "context hazard",
          },
        ],
      },
    });
    harness.controller.onProviderResponse(429);

    await harness.controller.handleSettled();

    expect(warnings(harness)).toEqual([]);
  });

  test("should still warn when routine switch chatter is muted", async () => {
    const harness = makeContextHarness({ config: { notifyUser: false } });
    harness.controller.onProviderResponse(429);

    await harness.controller.handleSettled();

    expect(harness.notifications.filter((n) => n.level === "info")).toEqual([]);
    expect(warnings(harness)).toEqual([
      "context hazard (openai-codex/gpt-5.6-sol: context ~330k > 270k)",
    ]);
  });

  test("should name the entry actually switched to when earlier chain entries are skipped", async () => {
    const harness = makeHarness({
      current: { provider: "github-copilot", id: "claude-opus-4.7" },
      getContextTokens: () => 330000,
      registered: {
        "github-copilot/claude-opus-4.7": true,
        "openrouter/skipped-unregistered": false,
        "anthropic/unauthorized": true,
        "openai-codex/gpt-5.6-sol": true,
      },
      authorized: { "anthropic/unauthorized": false },
      config: {
        chain: [
          { provider: "github-copilot", id: "claude-opus-4.7" },
          { provider: "openrouter", id: "skipped-unregistered" },
          { provider: "anthropic", id: "unauthorized" },
          { provider: "openai-codex", id: "gpt-5.6-sol" },
        ],
        contextWarnings: [
          { entry: { provider: "anthropic", id: "unauthorized" }, aboveTokens: 10, text: "wrong hazard" },
          CONTEXT_WARNING,
        ],
      },
    });
    harness.controller.onProviderResponse(429);

    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    if (outcome.kind === "switched") {
      expect(outcome.to).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    }
    expect(warnings(harness)).toEqual([
      "model-fallback: openrouter/skipped-unregistered not registered; skipping.",
      "model-fallback: anthropic/unauthorized unavailable (no auth); skipping.",
      "context hazard (openai-codex/gpt-5.6-sol: context ~330k > 270k)",
    ]);
  });

  test("should re-read the context size on every switch rather than caching it", async () => {
    const sizes: Array<number | undefined> = [330000, undefined];
    const harness = makeHarness({
      current: { provider: "github-copilot", id: "claude-opus-4.7" },
      getContextTokens: () => sizes.shift(),
      config: {
        chain: [
          { provider: "github-copilot", id: "claude-opus-4.7" },
          { provider: "openai-codex", id: "gpt-5.6-sol" },
          { provider: "openrouter", id: "google/gemini-3.7-flash" },
        ],
        contextWarnings: [
          CONTEXT_WARNING,
          {
            entry: { provider: "openrouter", id: "google/gemini-3.7-flash" },
            aboveTokens: 1000,
            text: "second hazard",
          },
        ],
      },
      registered: {
        "github-copilot/claude-opus-4.7": true,
        "openai-codex/gpt-5.6-sol": true,
        "openrouter/google/gemini-3.7-flash": true,
      },
    });

    harness.controller.onProviderResponse(429);
    await harness.controller.handleSettled();

    harness.controller.onProviderResponse(429);
    await harness.controller.handleSettled();

    expect(harness.continuations).toHaveLength(2);
    expect(harness.contextTokensCalls).toBe(2);
    // The second switch saw `undefined`, so no "second hazard" line.
    expect(warnings(harness)).toEqual([
      "context hazard (openai-codex/gpt-5.6-sol: context ~330k > 270k)",
    ]);
  });

  test("should emit both hazard notices before the continuation is dispatched", async () => {
    const harness = makeContextHarness({
      config: {
        paidEntries: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        paidNoticeText: "ALL LIMITS EXHAUSTED",
      },
      getContextTokens: () => 1_200_000,
    });
    harness.controller.onProviderResponse(429);

    await harness.controller.handleSettled();

    expect(harness.callOrder).toEqual([
      "notify:error",
      "notify:warning",
      "continuation",
      "notify:info",
    ]);
    expect(harness.notifications.filter((n) => n.level === "error")).toHaveLength(1);
    expect(warnings(harness)).toEqual([
      "context hazard (openai-codex/gpt-5.6-sol: context ~1.2M > 270k)",
    ]);
  });
});

describe("FallbackController compaction failures", () => {
  const NOTICE = "compaction died";
  const COMPACTION_RESUME = "compaction-resume-please";

  function makeCompactionHarness(overrides: HarnessOverrides = {}): Harness {
    return makeHarness({
      ...overrides,
      config: {
        compactionFailureNoticeText: NOTICE,
        compactionFailureResumeText: COMPACTION_RESUME,
        ...(overrides.config ?? {}),
      },
    });
  }

  test("should advance the chain when an overflow compaction never reports success", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true);

    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    if (outcome.kind === "switched") {
      expect(outcome.to).toEqual({ provider: "github-copilot", id: "claude-opus-4.7" });
      expect(outcome.trigger).toBe("compaction_failure");
    }
    expect(harness.continuations).toHaveLength(1);
    expect(harness.continuations[0]!.error.classification).toBe("compaction_failure");
    expect(harness.continuations[0]!.resumeText).toBe(COMPACTION_RESUME);
    expect(harness.notifications.filter((n) => n.level === "warning").map((n) => n.message)).toEqual([
      `${NOTICE} (anthropic/claude-opus-4-8 -> github-copilot/claude-opus-4.7)`,
    ]);
    // The info line is the only trace of WHICH trigger fired.
    expect(harness.notifications.filter((n) => n.level === "info").map((n) => n.message)).toEqual([
      "model-fallback: switched to github-copilot/claude-opus-4.7 (compaction_failure).",
    ]);
  });

  test("should carry the plain resumeText on an error-driven switch", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onProviderResponse(429);

    expect((await harness.controller.handleSettled()).kind).toBe("switched");

    expect(harness.continuations[0]!.resumeText).toBe("resume-please");
  });

  test("should ignore threshold and manual compaction reasons", async () => {
    for (const reason of ["threshold", "manual", undefined]) {
      const harness = makeCompactionHarness();
      harness.controller.onCompactionStart(reason, true);

      const outcome = await harness.controller.handleSettled();

      expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
      expect(harness.continuations).toEqual([]);
    }
  });

  test("should ignore a housekeeping compaction Pi was not going to retry", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", false, { aborted: false });

    const outcome = await harness.controller.handleSettled();

    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.setModelCalls).toEqual([]);
    expect(harness.continuations).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  test("should drop an attempt orphaned by a successful assistant message", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true);
    harness.controller.onAssistantMessage("stop", undefined);

    expect(harness.controller.snapshot().compactionPending).toBe(false);
    expect(await harness.controller.handleSettled()).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.continuations).toEqual([]);
  });

  test("should let the compaction trigger win over a recorded provider error", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onProviderResponse(500);
    harness.controller.onAssistantMessage("error", "internal server error");
    harness.controller.onCompactionStart("overflow", true);

    const outcome = await harness.controller.handleSettled();

    expect(outcome).toEqual({
      kind: "switched",
      to: { provider: "github-copilot", id: "claude-opus-4.7" },
      trigger: "compaction_failure",
    });
    // The stale 500 must not ride along as the cause of the switch.
    expect(harness.continuations).toHaveLength(1);
    expect(harness.continuations[0]).toEqual({
      previousModel: { provider: "anthropic", id: "claude-opus-4-8" },
      nextModel: { provider: "github-copilot", id: "claude-opus-4.7" },
      error: { classification: "compaction_failure" },
      resumeText: COMPACTION_RESUME,
    });
    expect("status" in harness.continuations[0]!.error).toBe(false);
    expect("message" in harness.continuations[0]!.error).toBe(false);
  });

  test("should report not-in-chain when the current model is outside the chain", async () => {
    const harness = makeCompactionHarness({
      current: { provider: "openrouter", id: "unlisted" },
    });
    harness.controller.onCompactionStart("overflow", true);

    expect(await harness.controller.handleSettled()).toEqual({ kind: "not-in-chain" });
    expect(harness.continuations).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  test("should not advance when the attempt was resolved by a successful compaction", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true);
    harness.controller.onCompactionEnd();

    const outcome = await harness.controller.handleSettled();

    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.continuations).toEqual([]);
  });

  test("should be fully inert when advanceOnCompactionFailure is false", async () => {
    const harness = makeCompactionHarness({ config: { advanceOnCompactionFailure: false } });
    harness.controller.onCompactionStart("overflow", true);

    expect(harness.controller.snapshot().compactionPending).toBe(false);
    const outcome = await harness.controller.handleSettled();

    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.continuations).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  test("should not advance when the user aborted the turn", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true);
    harness.controller.onAssistantMessage("aborted", undefined);

    const outcome = await harness.controller.handleSettled();

    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.continuations).toEqual([]);
  });

  test("should not advance when the compaction's abort signal reports a cancel", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true, { aborted: true });

    const outcome = await harness.controller.handleSettled();

    expect(outcome).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.continuations).toEqual([]);
    expect(harness.notifications).toEqual([]);
  });

  test("should advance when the abort signal reports the compaction was not cancelled", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true, { aborted: false });

    expect((await harness.controller.handleSettled()).kind).toBe("switched");
    expect(harness.continuations).toHaveLength(1);
  });

  test("should still advance when the event carried no abort signal", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true, undefined);

    expect((await harness.controller.handleSettled()).kind).toBe("switched");
    expect(harness.continuations).toHaveLength(1);
  });

  test("should treat a malformed abort signal as not cancelled without throwing", async () => {
    const malformed = [
      {},
      { aborted: "yes" },
      Object.defineProperty({}, "aborted", {
        get() {
          throw new Error("boom");
        },
      }),
    ];
    for (const signal of malformed) {
      const harness = makeCompactionHarness();
      harness.controller.onCompactionStart("overflow", true, signal as never);

      expect((await harness.controller.handleSettled()).kind).toBe("switched");
      expect(harness.continuations).toHaveLength(1);
    }
  });

  test("should advance again after an abort is followed by a fresh overflow attempt", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onAssistantMessage("aborted", undefined);
    harness.controller.onAssistantMessage("stop", undefined);
    harness.controller.onCompactionStart("overflow", true);

    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
  });

  test("should replace an unresolved attempt with a later one and act only once", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true);
    harness.controller.onCompactionStart("manual", true);

    // The replacement is a manual compaction, so nothing may fire.
    expect(await harness.controller.handleSettled()).toEqual({ kind: "noop", reason: "no_error" });

    harness.controller.onCompactionStart("overflow", true);
    expect((await harness.controller.handleSettled()).kind).toBe("switched");
    // The attempt was consumed by the switch; a second settle must be a no-op.
    expect(await harness.controller.handleSettled()).toEqual({ kind: "noop", reason: "no_error" });
    expect(harness.continuations).toHaveLength(1);
  });

  test("should clear a pending attempt on reset", async () => {
    const harness = makeCompactionHarness();
    harness.controller.onCompactionStart("overflow", true);
    expect(harness.controller.snapshot().compactionPending).toBe(true);

    harness.controller.reset();

    expect(harness.controller.snapshot().compactionPending).toBe(false);
    expect(await harness.controller.handleSettled()).toEqual({ kind: "noop", reason: "no_error" });
  });

  test("should skip unavailable entries and still emit the paid and context notices", async () => {
    const harness = makeCompactionHarness({
      current: { provider: "github-copilot", id: "claude-opus-4.7" },
      getContextTokens: () => 330000,
      registered: {
        "github-copilot/claude-opus-4.7": true,
        "openrouter/skipped-unregistered": false,
        "anthropic/unauthorized": true,
        "openai-codex/gpt-5.6-sol": true,
      },
      authorized: { "anthropic/unauthorized": false },
      config: {
        notifyUser: false,
        chain: [
          { provider: "github-copilot", id: "claude-opus-4.7" },
          { provider: "openrouter", id: "skipped-unregistered" },
          { provider: "anthropic", id: "unauthorized" },
          { provider: "openai-codex", id: "gpt-5.6-sol" },
        ],
        paidEntries: [{ provider: "openai-codex", id: "gpt-5.6-sol" }],
        paidNoticeText: "ALL LIMITS EXHAUSTED",
        contextWarnings: [
          {
            entry: { provider: "openai-codex", id: "gpt-5.6-sol" },
            aboveTokens: 270000,
            text: "context hazard",
          },
        ],
      },
    });
    harness.controller.onCompactionStart("overflow", true);

    const outcome = await harness.controller.handleSettled();

    expect(outcome.kind).toBe("switched");
    if (outcome.kind === "switched") {
      expect(outcome.to).toEqual({ provider: "openai-codex", id: "gpt-5.6-sol" });
    }
    // notifyUser=false silences the skip lines but not the three hazard notices.
    expect(harness.notifications.map((n) => n.message)).toEqual([
      `${NOTICE} (github-copilot/claude-opus-4.7 -> openai-codex/gpt-5.6-sol)`,
      "ALL LIMITS EXHAUSTED (openai-codex/gpt-5.6-sol)",
      "context hazard (openai-codex/gpt-5.6-sol: context ~330k > 270k)",
    ]);
    expect(harness.callOrder).toEqual([
      "notify:warning",
      "notify:error",
      "notify:warning",
      "continuation",
    ]);
  });

  test("should report chain exhaustion instead of switching at the tail of the chain", async () => {
    const harness = makeCompactionHarness({
      current: { provider: "openai-codex", id: "gpt-5.6-sol" },
    });
    harness.controller.onCompactionStart("overflow", true);

    expect(await harness.controller.handleSettled()).toEqual({ kind: "chain-exhausted" });
    expect(harness.continuations).toEqual([]);
  });

  test("should stay dormant when the extension is disabled", async () => {
    const harness = makeCompactionHarness({ config: { enabled: false } });
    harness.controller.onCompactionStart("overflow", true);

    expect(await harness.controller.handleSettled()).toEqual({ kind: "noop", reason: "disabled" });
    expect(harness.continuations).toEqual([]);
  });
});

describe("formatTokens", () => {
  test("should render each rounding band without a wrong-unit reading", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(270_000)).toBe("270k");
    expect(formatTokens(330_000)).toBe("330k");
    expect(formatTokens(999_499)).toBe("999k");
    expect(formatTokens(999_500)).toBe("1M");
    expect(formatTokens(999_999)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_050_000)).toBe("1.05M");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(10_000_000)).toBe("10M");
  });
});
