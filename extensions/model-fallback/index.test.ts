import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import factory from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeAPI {
  handlers: Map<string, Handler[]>;
  sendMessage: (message: unknown, options?: unknown) => void;
  setModel: (model: unknown) => Promise<boolean>;
  sentMessages: Array<{ message: any; options: any }>;
  setModelCalls: unknown[];
}

function makeFakeAPI(overrides?: {
  setModel?: (model: unknown) => Promise<boolean>;
  sendMessage?: (message: unknown, options: unknown) => void;
}): FakeAPI {
  const handlers = new Map<string, Handler[]>();
  const sentMessages: Array<{ message: any; options: any }> = [];
  const setModelCalls: unknown[] = [];

  const api: FakeAPI = {
    handlers,
    sentMessages,
    setModelCalls,
    sendMessage: overrides?.sendMessage
      ? (message, options) => {
          sentMessages.push({ message, options });
          overrides.sendMessage!(message, options);
        }
      : (message, options) => {
          sentMessages.push({ message, options });
        },
    setModel: overrides?.setModel
      ? async (m) => {
          setModelCalls.push(m);
          return overrides.setModel!(m);
        }
      : async (m) => {
          setModelCalls.push(m);
          return true;
        },
  };

  return api;
}

function toPiApi(fake: FakeAPI): any {
  return {
    on(event: string, handler: Handler) {
      const list = fake.handlers.get(event) ?? [];
      list.push(handler);
      fake.handlers.set(event, list);
    },
    sendMessage: (message: unknown, options?: unknown) => fake.sendMessage(message, options),
    setModel: (model: unknown) => fake.setModel(model),
  };
}

async function emit(fake: FakeAPI, event: string, payload: unknown, ctx: unknown): Promise<void> {
  const list = fake.handlers.get(event) ?? [];
  for (const handler of list) {
    await handler(payload, ctx);
  }
}

// Yield once for the setTimeout(0) that defers the followUp dispatch out of
// the current `agent_settled` unwind — mirrors production timing.
async function flushDeferred(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const ORIGINAL_DEPTH = process.env.PI_COLLAB_SUBAGENT_DEPTH;
const ORIGINAL_HOME = process.env.HOME;
const tempHome: { path?: string } = {};

beforeEach(() => {
  delete process.env.PI_COLLAB_SUBAGENT_DEPTH;
  const dir = require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "mf-index-"),
  );
  tempHome.path = dir;
  process.env.HOME = dir;
});

afterEach(() => {
  if (tempHome.path) {
    require("node:fs").rmSync(tempHome.path, { recursive: true, force: true });
    tempHome.path = undefined;
  }
  if (typeof ORIGINAL_HOME === "string") process.env.HOME = ORIGINAL_HOME;
  else delete process.env.HOME;
  if (typeof ORIGINAL_DEPTH === "string") process.env.PI_COLLAB_SUBAGENT_DEPTH = ORIGINAL_DEPTH;
  else delete process.env.PI_COLLAB_SUBAGENT_DEPTH;
});

function writeGlobalConfig(config: unknown): void {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.join(tempHome.path!, ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "model-fallback.json"), JSON.stringify(config), "utf-8");
}

// Drives a full 429 -> switch cycle onto an entry that has a contextWarning,
// returning the notifications so each `getContextUsage` shape can be asserted
// against the same otherwise-identical scenario.
async function runContextWarningScenario(
  getContextUsage: () => unknown,
): Promise<Array<{ message: string; level: string }>> {
  writeGlobalConfig({
    enabled: true,
    chain: ["anthropic/opus", "openai-codex/gpt-5.6-sol"],
    orchestratorOnly: true,
    contextWarnings: [{ entry: "openai-codex/gpt-5.6-sol", aboveTokens: 270000, text: "ctx" }],
  });
  const fake = makeFakeAPI();
  factory(toPiApi(fake));

  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    cwd: process.cwd(),
    model: { provider: "anthropic", id: "opus" },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    getContextUsage,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
  };

  await emit(fake, "session_start", { reason: "startup" }, ctx);
  await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
  await emit(
    fake,
    "message_end",
    { message: { role: "assistant", stopReason: "error", errorMessage: "rate limit" } },
    ctx,
  );
  await emit(fake, "agent_settled", {}, ctx);
  await flushDeferred();

  expect(fake.sentMessages).toHaveLength(1);
  return notifications;
}

describe("model-fallback extension entry", () => {
  test("should stay dormant in a subagent when orchestratorOnly is true even though handlers are registered", async () => {
    writeGlobalConfig({ enabled: true, chain: ["a/b", "c/d"], orchestratorOnly: true });
    process.env.PI_COLLAB_SUBAGENT_DEPTH = "1";
    const fake = makeFakeAPI();
    factory(toPiApi(fake));

    const ctx = {
      cwd: process.cwd(),
      model: { provider: "a", id: "b" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: () => {} },
    };
    await emit(fake, "session_start", { reason: "startup" }, ctx);
    await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
    await emit(fake, "agent_settled", {}, ctx);
    await flushDeferred();

    expect(fake.setModelCalls).toEqual([]);
    expect(fake.sentMessages).toEqual([]);
  });

  test("should activate in a subagent when orchestratorOnly is false", async () => {
    writeGlobalConfig({
      enabled: true,
      chain: ["anthropic/opus", "github-copilot/claude"],
      orchestratorOnly: false,
    });
    process.env.PI_COLLAB_SUBAGENT_DEPTH = "2";
    const fake = makeFakeAPI();
    factory(toPiApi(fake));

    const ctx = {
      cwd: process.cwd(),
      model: { provider: "anthropic", id: "opus" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: () => {} },
    };
    await emit(fake, "session_start", { reason: "startup" }, ctx);
    await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
    await emit(fake, "agent_settled", {}, ctx);
    await flushDeferred();

    expect((fake.setModelCalls as any[]).map((m) => m.id)).toEqual(["claude"]);
    expect(fake.sentMessages).toHaveLength(1);
  });

  test("should trigger provider switch and send continuation after settle following a 429", async () => {
    writeGlobalConfig({
      enabled: true,
      chain: ["anthropic/opus", "github-copilot/claude"],
      resumeText: "please continue",
      orchestratorOnly: true,
    });
    const fake = makeFakeAPI();
    factory(toPiApi(fake));

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      cwd: process.cwd(),
      model: { provider: "anthropic", id: "opus" },
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id }),
      },
      ui: {
        notify: (message: string, level: string) => {
          notifications.push({ message, level });
        },
      },
    };

    await emit(fake, "session_start", { reason: "startup" }, ctx);
    await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
    await emit(
      fake,
      "message_end",
      { message: { role: "assistant", stopReason: "error", errorMessage: "rate limit" } },
      ctx,
    );
    await emit(fake, "agent_settled", {}, ctx);

    // sendMessage is deferred; nothing sent yet.
    expect(fake.sentMessages).toEqual([]);
    await flushDeferred();

    expect(fake.setModelCalls).toEqual([{ provider: "github-copilot", id: "claude" }]);
    expect(fake.sentMessages).toHaveLength(1);
    const sent = fake.sentMessages[0]!;
    expect(sent.message.customType).toBe("model-fallback:continuation");
    expect(sent.message.content).toBe("please continue");
    expect(sent.message.details.previousModel).toEqual({ provider: "anthropic", id: "opus" });
    expect(sent.message.details.nextModel).toEqual({ provider: "github-copilot", id: "claude" });
    expect(sent.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  });

  test("should read the context size from getContextUsage so warnings can fire", async () => {
    const notifications = await runContextWarningScenario(() => ({
      tokens: 330000,
      contextWindow: 1_000_000,
      percent: 33,
    }));

    expect(notifications.filter((n) => n.level === "warning").map((n) => n.message)).toEqual([
      "ctx (openai-codex/gpt-5.6-sol: context ~330k > 270k)",
    ]);
  });

  test("should stay silent when getContextUsage reports an unknown size or throws", async () => {
    const postCompaction = await runContextWarningScenario(() => ({
      tokens: null,
      contextWindow: 1_000_000,
      percent: null,
    }));
    expect(postCompaction.filter((n) => n.message.startsWith("ctx"))).toEqual([]);

    const absent = await runContextWarningScenario(() => undefined);
    expect(absent.filter((n) => n.message.startsWith("ctx"))).toEqual([]);

    const thrown = await runContextWarningScenario(() => {
      throw new Error("session is not active");
    });
    expect(thrown.filter((n) => n.message.startsWith("ctx"))).toEqual([]);
  });

  test("should skip a chain entry when setModel returns false", async () => {
    writeGlobalConfig({
      enabled: true,
      chain: ["anthropic/opus", "github-copilot/claude", "openai-codex/gpt"],
      orchestratorOnly: true,
    });
    const fake = makeFakeAPI({
      setModel: async (m: any) => (m.id === "gpt" ? true : false),
    });
    factory(toPiApi(fake));

    const ctx = {
      cwd: process.cwd(),
      model: { provider: "anthropic", id: "opus" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: () => {} },
    };

    await emit(fake, "session_start", { reason: "startup" }, ctx);
    await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
    await emit(fake, "agent_settled", {}, ctx);
    await flushDeferred();

    expect((fake.setModelCalls as any[]).map((m) => m.id)).toEqual(["claude", "gpt"]);
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]!.message.details.nextModel).toEqual({
      provider: "openai-codex",
      id: "gpt",
    });
  });

  test("should cascade to the third chain entry when the fallback provider's own turn also 429s", async () => {
    // Reproduces the reentrant scenario from review §🔴: without deferral,
    // the nested `agent_settled` from the follow-up turn was swallowed by
    // `switchingInFlight` and the subsequent state wipe erased the error,
    // pinning the chain to a single hop.
    writeGlobalConfig({
      enabled: true,
      chain: [
        "anthropic/claude-opus-4-8",
        "github-copilot/claude-opus-4.7",
        "openai-codex/gpt-5.6-sol",
      ],
      resumeText: "resume",
      orchestratorOnly: true,
    });

    const state = { current: { provider: "anthropic", id: "claude-opus-4-8" } as any };
    const nestedRuns: number[] = [];

    // Fake sendMessage simulates Pi accepting the followUp and running a
    // fresh nested turn. That nested turn ALSO 429s, so the extension must
    // schedule a second continuation for the third chain entry.
    const fake = makeFakeAPI({
      setModel: async (m: any) => {
        state.current = { provider: m.provider, id: m.id };
        return true;
      },
      sendMessage: () => {
        nestedRuns.push(nestedRuns.length + 1);
        if (nestedRuns.length !== 1) return;
        // Only the first followUp (into copilot) should produce another 429.
        const ctxNested = {
          cwd: process.cwd(),
          model: state.current,
          modelRegistry: {
            find: (provider: string, id: string) => ({ provider, id }),
          },
          ui: { notify: () => {} },
        };
        void (async () => {
          await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctxNested);
          await emit(
            fake,
            "message_end",
            { message: { role: "assistant", stopReason: "error", errorMessage: "quota" } },
            ctxNested,
          );
          await emit(fake, "agent_settled", {}, ctxNested);
        })();
      },
    });

    factory(toPiApi(fake));

    const ctx = {
      cwd: process.cwd(),
      get model() {
        return state.current;
      },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: () => {} },
    };

    await emit(fake, "session_start", { reason: "startup" }, ctx);
    await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
    await emit(
      fake,
      "message_end",
      { message: { role: "assistant", stopReason: "error", errorMessage: "quota" } },
      ctx,
    );
    await emit(fake, "agent_settled", {}, ctx);
    // Flush twice: first timer drives the copilot followUp (which schedules
    // a second continuation from within its nested agent_settled), second
    // timer drives the openai-codex followUp.
    await flushDeferred(2);

    expect((fake.setModelCalls as any[]).map((m) => `${m.provider}/${m.id}`)).toEqual([
      "github-copilot/claude-opus-4.7",
      "openai-codex/gpt-5.6-sol",
    ]);
    expect(fake.sentMessages).toHaveLength(2);
    expect(fake.sentMessages[0]!.message.details.nextModel).toEqual({
      provider: "github-copilot",
      id: "claude-opus-4.7",
    });
    expect(fake.sentMessages[1]!.message.details.nextModel).toEqual({
      provider: "openai-codex",
      id: "gpt-5.6-sol",
    });
  });

  test("should clear scheduled continuations on session_shutdown", async () => {
    writeGlobalConfig({
      enabled: true,
      chain: ["anthropic/opus", "github-copilot/claude"],
      orchestratorOnly: true,
    });
    const fake = makeFakeAPI();
    factory(toPiApi(fake));

    const ctx = {
      cwd: process.cwd(),
      model: { provider: "anthropic", id: "opus" },
      modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
      ui: { notify: () => {} },
    };

    await emit(fake, "session_start", { reason: "startup" }, ctx);
    await emit(fake, "after_provider_response", { status: 429, headers: {} }, ctx);
    await emit(fake, "agent_settled", {}, ctx);
    await emit(fake, "session_shutdown", {}, ctx);
    await flushDeferred();

    expect(fake.sentMessages).toEqual([]);
  });
});
