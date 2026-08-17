import { classifyError, type FallbackClassification } from "./classify.ts";
import {
  findContextWarning,
  isPaidEntry,
  type ChainEntry,
  type ModelFallbackConfig,
} from "./config.ts";

export interface ControllerModelRef {
  provider: string;
  id: string;
}

export interface ResolvedModel extends ControllerModelRef {
  raw: unknown;
}

export interface ControllerDeps {
  config: ModelFallbackConfig;
  getCurrentModel: () => ControllerModelRef | undefined;
  findModel: (entry: ChainEntry) => ResolvedModel | undefined;
  setModel: (model: ResolvedModel) => Promise<boolean>;
  sendContinuation: (payload: ContinuationPayload) => Promise<void>;
  notify: (message: string, level: "info" | "warning" | "error") => void;
  /** Live context size, or `undefined` when Pi cannot report a trustworthy one. */
  getContextTokens: () => number | undefined;
}

export interface ContinuationPayload {
  previousModel: ControllerModelRef;
  nextModel: ControllerModelRef;
  error: { status?: number; message?: string; classification: string };
  resumeText: string;
}

export interface RecordedError {
  status?: number;
  errorMessage?: string;
}

export function formatTokens(tokens: number): string {
  // 999_500+ rounds to 1000k, which reads as a wrong unit — promote to M.
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export type SwitchTrigger = "error" | "compaction_failure";

export type SettleOutcome =
  | { kind: "noop"; reason: string }
  | { kind: "not-eligible"; reason: string }
  | { kind: "not-in-chain" }
  | { kind: "chain-exhausted" }
  | { kind: "switched"; to: ControllerModelRef; trigger: SwitchTrigger }
  | { kind: "no-available-entry" };

/** Structural minimum of `AbortSignal` — the event carries a real one. */
export interface AbortSignalLike {
  aborted: boolean;
}

interface CompactionAttempt {
  reason: string | undefined;
  willRetry: boolean;
  signal: AbortSignalLike | undefined;
}

export class FallbackController {
  private lastStatus: number | undefined;
  private lastErrorMessage: string | undefined;
  private lastStopReason: string | undefined;
  private switchingInFlight = false;
  private exhaustedNotified = false;
  private pendingCompaction: CompactionAttempt | undefined;

  constructor(private readonly deps: ControllerDeps) {}

  reset(): void {
    this.lastStatus = undefined;
    this.lastErrorMessage = undefined;
    this.lastStopReason = undefined;
    this.switchingInFlight = false;
    this.exhaustedNotified = false;
    this.pendingCompaction = undefined;
  }

  onProviderResponse(status: number | undefined): void {
    this.lastStatus = status;
  }

  /** A second start before a resolution replaces the first: only one can be live. */
  onCompactionStart(
    reason: string | undefined,
    willRetry: boolean,
    signal?: AbortSignalLike | undefined,
  ): void {
    if (!this.deps.config.advanceOnCompactionFailure) return;
    this.pendingCompaction = { reason, willRetry, signal };
  }

  onCompactionEnd(): void {
    this.pendingCompaction = undefined;
  }

  onAssistantMessage(stopReason: string | undefined, errorMessage: string | undefined): void {
    this.lastStopReason = stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      this.lastErrorMessage = errorMessage ?? this.lastErrorMessage;
      return;
    }
    this.lastStatus = undefined;
    this.lastErrorMessage = undefined;
    this.exhaustedNotified = false;
    // A completed turn also invalidates any attempt still pending from before
    // it. Safe for the in-turn overflow case: `message_end` fires before Pi's
    // own compaction check, so an in-turn attempt is always recorded after
    // this clear.
    this.pendingCompaction = undefined;
  }

  classify(): FallbackClassification {
    return classifyError({ status: this.lastStatus, errorMessage: this.lastErrorMessage });
  }

  async handleSettled(): Promise<SettleOutcome> {
    if (!this.deps.config.enabled) return { kind: "noop", reason: "disabled" };
    if (this.switchingInFlight) return { kind: "noop", reason: "in_flight" };

    // Pi emits no extension-visible event for a failed compaction, so an
    // attempt that never reported success is the only signal we get. Consumed
    // before the no_error return: that is exactly the state a dead compaction
    // leaves behind.
    if (this.consumeCompactionTrigger()) {
      return this.switchToNextEntry("compaction_failure", "compaction_failure");
    }

    if (this.lastStatus === undefined && !this.lastErrorMessage) {
      return { kind: "noop", reason: "no_error" };
    }

    const classification = this.classify();
    if (!classification.eligible) {
      return { kind: "not-eligible", reason: classification.reason };
    }

    return this.switchToNextEntry("error", classification.reason);
  }

  /**
   * A cancel is ruled out by the attempt's abort signal; everything else that
   * stays ambiguous resolves to "do not switch".
   */
  private consumeCompactionTrigger(): boolean {
    const attempt = this.pendingCompaction;
    if (!attempt) return false;
    this.pendingCompaction = undefined;
    if (!this.deps.config.advanceOnCompactionFailure) return false;
    // Known accepted limitation: if another extension cancels compaction via
    // `session_before_compact` returning `{ cancel: true }`, Pi emits no
    // `session_compact` and leaves the signal unaborted, so a deliberate
    // "do not compact" would read as a failure. No extension here does that.
    //
    // Pi was not going to retry, so nothing is stalled: `willRetry === false`
    // means the provider already returned a complete answer and this is only
    // housekeeping — there is no interrupted work to resume.
    if (!attempt.willRetry) return false;
    // A failed threshold/manual compaction says nothing about provider health,
    // and "aborted" means the user cancelled — never switch behind a cancel.
    if (attempt.reason !== "overflow") return false;
    // The event's own abort signal is the precise discriminator: a compaction
    // that failed leaves it unaborted, one the user cancelled leaves it
    // aborted — and a cancel appends no assistant message, so `lastStopReason`
    // alone cannot see it. Malformed/missing signals read as "not aborted" so
    // an unexpected payload shape cannot disable the feature outright.
    let aborted = false;
    try {
      aborted = attempt.signal?.aborted === true;
    } catch {
      aborted = false;
    }
    if (aborted) return false;
    if (this.lastStopReason === "aborted") return false;
    return true;
  }

  private async switchToNextEntry(
    trigger: SwitchTrigger,
    classificationReason: string,
  ): Promise<SettleOutcome> {
    const current = this.deps.getCurrentModel();
    if (!current) return { kind: "noop", reason: "no_current_model" };

    const chain = this.deps.config.chain;
    const currentIndex = chain.findIndex(
      (entry) =>
        entry.provider.toLowerCase() === current.provider.toLowerCase() &&
        entry.id.toLowerCase() === current.id.toLowerCase(),
    );

    if (currentIndex === -1) return { kind: "not-in-chain" };
    if (currentIndex >= chain.length - 1) {
      if (!this.exhaustedNotified) {
        this.exhaustedNotified = true;
        if (this.deps.config.notifyUser) {
          this.deps.notify(
            "model-fallback: chain exhausted; staying on current model.",
            "warning",
          );
        }
      }
      return { kind: "chain-exhausted" };
    }

    this.switchingInFlight = true;
    try {
      for (let index = currentIndex + 1; index < chain.length; index++) {
        const entry = chain[index]!;
        const resolved = this.deps.findModel(entry);
        if (!resolved) {
          if (this.deps.config.notifyUser) {
            this.deps.notify(
              `model-fallback: ${entry.provider}/${entry.id} not registered; skipping.`,
              "warning",
            );
          }
          continue;
        }
        const ok = await this.deps.setModel(resolved);
        if (!ok) {
          if (this.deps.config.notifyUser) {
            this.deps.notify(
              `model-fallback: ${entry.provider}/${entry.id} unavailable (no auth); skipping.`,
              "warning",
            );
          }
          continue;
        }

        const previousModel: ControllerModelRef = { provider: current.provider, id: current.id };
        const nextModel: ControllerModelRef = { provider: resolved.provider, id: resolved.id };
        // A compaction failure has no status/message of its own; the resident
        // ones belong to an earlier, non-eligible response and must not ride
        // along as if they were the cause.
        const errorSnapshot: ContinuationPayload["error"] =
          trigger === "compaction_failure"
            ? { classification: classificationReason }
            : {
                status: this.lastStatus,
                message: this.lastErrorMessage,
                classification: classificationReason,
              };
        const resumeText =
          trigger === "compaction_failure"
            ? this.deps.config.compactionFailureResumeText
            : this.deps.config.resumeText;

        // Outside the notifyUser guard for the same reason as the notices
        // below: without it the model change has no visible cause at all.
        if (trigger === "compaction_failure") {
          this.deps.notify(
            `${this.deps.config.compactionFailureNoticeText} (${previousModel.provider}/${previousModel.id} -> ${nextModel.provider}/${nextModel.id})`,
            "warning",
          );
        }

        // Billing notice is deliberately outside the notifyUser guard: muting
        // routine switch chatter must not also mute "you are now paying".
        if (isPaidEntry(this.deps.config, nextModel)) {
          this.deps.notify(
            `${this.deps.config.paidNoticeText} (${resolved.provider}/${resolved.id})`,
            "error",
          );
        }

        // Same rationale as the billing notice: a context hazard on the target
        // provider is not routine switch chatter. Silent when Pi cannot report
        // a trustworthy size — guessing would be worse than mute.
        const contextWarning = findContextWarning(this.deps.config, nextModel);
        // Reading the size walks the message list, so only pay for it when an
        // entry actually has a threshold configured.
        const contextTokens = contextWarning ? this.deps.getContextTokens() : undefined;
        if (
          contextWarning &&
          contextTokens !== undefined &&
          contextTokens > contextWarning.aboveTokens
        ) {
          this.deps.notify(
            `${contextWarning.text} (${resolved.provider}/${resolved.id}: context ~${formatTokens(
              contextTokens,
            )} > ${formatTokens(contextWarning.aboveTokens)})`,
            "warning",
          );
        }

        await this.deps.sendContinuation({
          previousModel,
          nextModel,
          error: errorSnapshot,
          resumeText,
        });

        if (this.deps.config.notifyUser) {
          this.deps.notify(
            `model-fallback: switched to ${resolved.provider}/${resolved.id} (${classificationReason}).`,
            "info",
          );
        }

        this.lastStatus = undefined;
        this.lastErrorMessage = undefined;
        return { kind: "switched", to: nextModel, trigger };
      }

      if (!this.exhaustedNotified) {
        this.exhaustedNotified = true;
        if (this.deps.config.notifyUser) {
          this.deps.notify(
            "model-fallback: no available fallback in remaining chain.",
            "warning",
          );
        }
      }
      return { kind: "no-available-entry" };
    } finally {
      this.switchingInFlight = false;
    }
  }

  snapshot(): {
    status?: number;
    errorMessage?: string;
    switching: boolean;
    exhausted: boolean;
    compactionPending: boolean;
  } {
    return {
      status: this.lastStatus,
      errorMessage: this.lastErrorMessage,
      switching: this.switchingInFlight,
      exhausted: this.exhaustedNotified,
      compactionPending: this.pendingCompaction !== undefined,
    };
  }
}
