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

export type SettleOutcome =
  | { kind: "noop"; reason: string }
  | { kind: "not-eligible"; reason: string }
  | { kind: "not-in-chain" }
  | { kind: "chain-exhausted" }
  | { kind: "switched"; to: ControllerModelRef }
  | { kind: "no-available-entry" };

export class FallbackController {
  private lastStatus: number | undefined;
  private lastErrorMessage: string | undefined;
  private switchingInFlight = false;
  private exhaustedNotified = false;

  constructor(private readonly deps: ControllerDeps) {}

  reset(): void {
    this.lastStatus = undefined;
    this.lastErrorMessage = undefined;
    this.switchingInFlight = false;
    this.exhaustedNotified = false;
  }

  onProviderResponse(status: number | undefined): void {
    this.lastStatus = status;
  }

  onAssistantMessage(stopReason: string | undefined, errorMessage: string | undefined): void {
    if (stopReason === "error" || stopReason === "aborted") {
      this.lastErrorMessage = errorMessage ?? this.lastErrorMessage;
      return;
    }
    this.lastStatus = undefined;
    this.lastErrorMessage = undefined;
    this.exhaustedNotified = false;
  }

  classify(): FallbackClassification {
    return classifyError({ status: this.lastStatus, errorMessage: this.lastErrorMessage });
  }

  async handleSettled(): Promise<SettleOutcome> {
    if (!this.deps.config.enabled) return { kind: "noop", reason: "disabled" };
    if (this.switchingInFlight) return { kind: "noop", reason: "in_flight" };
    if (this.lastStatus === undefined && !this.lastErrorMessage) {
      return { kind: "noop", reason: "no_error" };
    }

    const classification = this.classify();
    if (!classification.eligible) {
      return { kind: "not-eligible", reason: classification.reason };
    }

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
        const errorSnapshot = {
          status: this.lastStatus,
          message: this.lastErrorMessage,
          classification: classification.reason,
        };

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
          resumeText: this.deps.config.resumeText,
        });

        if (this.deps.config.notifyUser) {
          this.deps.notify(
            `model-fallback: switched to ${resolved.provider}/${resolved.id} (${classification.reason}).`,
            "info",
          );
        }

        this.lastStatus = undefined;
        this.lastErrorMessage = undefined;
        return { kind: "switched", to: nextModel };
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
  } {
    return {
      status: this.lastStatus,
      errorMessage: this.lastErrorMessage,
      switching: this.switchingInFlight,
      exhausted: this.exhaustedNotified,
    };
  }
}
