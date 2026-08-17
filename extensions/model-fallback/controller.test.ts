import { describe, expect, test } from "bun:test";
import {
  FallbackController,
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
}

interface HarnessOverrides {
  config?: Partial<ModelFallbackConfig>;
  current?: ControllerModelRef | undefined;
  registered?: Record<string, boolean>;
  authorized?: Record<string, boolean>;
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
    },
    notify: (message, level) => {
      notifications.push({ message, level });
    },
  };

  return {
    controller: new FallbackController(deps),
    notifications,
    continuations,
    setModelCalls,
    findCalls,
  };
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
