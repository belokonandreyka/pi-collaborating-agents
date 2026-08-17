import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";
import { loadConfig, type ChainEntry, type ModelFallbackConfig } from "./config.ts";
import {
  FallbackController,
  type ContinuationPayload,
  type ControllerModelRef,
  type ResolvedModel,
} from "./controller.ts";

const CUSTOM_TYPE = "model-fallback:continuation";

// Peer typings `@mariozechner/pi-coding-agent@0.73.1` do not yet declare
// `agent_settled`; runtime Pi (earendil >=0.74) does emit it. Cast through a
// compatibility shape so the handler registers without a dependency bump.
type SettledCapableAPI = ExtensionAPI & {
  on(event: "agent_settled", handler: (event: unknown, ctx: ExtensionContext) => unknown): void;
};

function isSubagent(): boolean {
  const depth = Number(process.env.PI_COLLAB_SUBAGENT_DEPTH ?? 0);
  return Number.isFinite(depth) && depth > 0;
}

function toControllerModelRef(model: Model<any> | undefined): ControllerModelRef | undefined {
  if (!model) return undefined;
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  if (typeof provider !== "string" || typeof id !== "string") return undefined;
  return { provider, id };
}

export default function (pi: ExtensionAPI): void {
  const controllerRef: { current: FallbackController | undefined } = { current: undefined };
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  // A throwing host notify would abort handleSettled before the continuation is
  // scheduled, i.e. cosmetics would stall the chain. Swallow it at the one place
  // every call site funnels through.
  const notify = (message: string, level: "info" | "warning" | "error", ctx?: ExtensionContext) => {
    try {
      ctx?.ui?.notify?.(message, level);
    } catch {
      // ignore
    }
  };

  const buildController = (config: ModelFallbackConfig, ctx: ExtensionContext): FallbackController =>
    new FallbackController({
      config,
      getCurrentModel: () => toControllerModelRef(ctx.model),
      findModel: (entry: ChainEntry): ResolvedModel | undefined => {
        const model = ctx.modelRegistry.find(entry.provider, entry.id);
        if (!model) return undefined;
        return { provider: entry.provider, id: entry.id, raw: model };
      },
      setModel: async (model: ResolvedModel) => {
        try {
          const result = await pi.setModel(model.raw as Model<any>);
          return result !== false;
        } catch {
          return false;
        }
      },
      // Deferred so the outer `agent_settled` handler (called inside
      // `_runAgentPrompt.finally`) fully unwinds before we start a new turn.
      // Otherwise `pi.sendMessage(..., { triggerTurn: true })` nests
      // synchronously and any nested failure would be swallowed by the
      // controller's own `switchingInFlight` guard (see review §🔴).
      sendContinuation: async (payload: ContinuationPayload) => {
        const timer = setTimeout(() => {
          pendingTimers.delete(timer);
          try {
            pi.sendMessage(
              {
                customType: CUSTOM_TYPE,
                content: payload.resumeText,
                display: true,
                details: {
                  previousModel: payload.previousModel,
                  nextModel: payload.nextModel,
                  error: payload.error,
                },
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            notify(`model-fallback: continuation dispatch failed: ${detail}`, "error", ctx);
          }
        }, 0);
        pendingTimers.add(timer);
      },
      notify: (message, level) => notify(message, level, ctx),
      // `getContextUsage` reports `tokens: null` when a compaction happened and
      // no valid post-compaction usage exists yet; both that and `undefined`
      // mean "unknown", never "zero". The accessor asserts an active runtime,
      // so a torn-down session must not throw into the settle path.
      getContextTokens: () => {
        try {
          const usage = ctx.getContextUsage();
          const tokens = usage?.tokens;
          if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) {
            return undefined;
          }
          return tokens;
        } catch {
          return undefined;
        }
      },
    });

  const clearPendingTimers = (): void => {
    for (const timer of pendingTimers) clearTimeout(timer);
    pendingTimers.clear();
  };

  pi.on("session_start", async (_event, ctx) => {
    clearPendingTimers();
    // Config is loaded per session so project overrides follow session cwd
    // across resume / switch / rebind. `orchestratorOnly` is re-evaluated
    // here too — child sessions leave the controller undefined instead of
    // preventing handler registration at factory time.
    const config = loadConfig(ctx.cwd);
    if (config.orchestratorOnly && isSubagent()) {
      controllerRef.current = undefined;
      return;
    }
    controllerRef.current = buildController(config, ctx);
  });

  pi.on("session_shutdown", async () => {
    clearPendingTimers();
    controllerRef.current?.reset();
    controllerRef.current = undefined;
  });

  pi.on("after_provider_response", (event) => {
    controllerRef.current?.onProviderResponse(event.status);
  });

  const handleAssistantMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const asRecord = message as {
      role?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (asRecord.role !== "assistant") return;
    const stopReason = typeof asRecord.stopReason === "string" ? asRecord.stopReason : undefined;
    const errorMessage = typeof asRecord.errorMessage === "string" ? asRecord.errorMessage : undefined;
    controllerRef.current?.onAssistantMessage(stopReason, errorMessage);
  };

  // `message_end` already carries finalized stopReason / errorMessage; a
  // duplicate `turn_end` subscription would double-process each assistant
  // response and obscure ordering relative to `after_provider_response`.
  pi.on("message_end", (event) => {
    handleAssistantMessage((event as { message?: unknown }).message);
  });

  // Registering a handler is what makes Pi emit `session_before_compact` at
  // all, and that emission is the only public trace of a compaction attempt —
  // so this stays registered even when the controller is dormant. It must
  // never influence compaction: no `cancel`, no supplied summary, nothing
  // thrown back into Pi's compaction path.
  pi.on("session_before_compact", (event) => {
    try {
      // The pinned peer typings predate `reason` / `willRetry` / `signal`.
      const record = event as unknown as {
        reason?: unknown;
        willRetry?: unknown;
        signal?: unknown;
      };
      const reason = typeof record?.reason === "string" ? record.reason : undefined;
      const rawSignal = record?.signal;
      const signal =
        typeof rawSignal === "object" &&
        rawSignal !== null &&
        typeof (rawSignal as { aborted?: unknown }).aborted === "boolean"
          ? (rawSignal as { aborted: boolean })
          : undefined;
      controllerRef.current?.onCompactionStart(reason, record?.willRetry === true, signal);
    } catch {
      // ignore
    }
    return undefined;
  });

  // Pi also runs its compaction check before a new user prompt, outside any
  // agent run, and discards the result. `agent_settled` only fires inside a
  // run, so such an attempt would otherwise be consumed at the settle of the
  // next, unrelated turn. This fires after that pre-prompt check and only on
  // the user-prompt path, so it drops exactly the orphan.
  pi.on("before_agent_start", () => {
    try {
      controllerRef.current?.onCompactionEnd();
    } catch {
      // ignore
    }
    return undefined;
  });

  pi.on("session_compact", () => {
    try {
      controllerRef.current?.onCompactionEnd();
    } catch {
      // ignore
    }
  });

  (pi as SettledCapableAPI).on("agent_settled", async () => {
    await controllerRef.current?.handleSettled();
  });
}
