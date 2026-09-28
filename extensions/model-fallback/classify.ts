export type FallbackClassification =
  | { eligible: true; reason: string }
  | { eligible: false; reason: string };

export interface ClassifyInput {
  status?: number;
  errorMessage?: string;
}

const AUTH_STATUS_CODES = new Set([401, 403]);

// A provider that cannot serve the model right now, as opposed to one that
// refuses it: Bedrock answers `503 ServiceUnavailableException: Bedrock is
// unable to process your request` after 60–120 s when a model is short of
// capacity (Opus 5.5, 2026-09-28: every request for half an hour, then none),
// Anthropic answers 529 overloaded. pi's own retries run first; when they are
// exhausted the next chain entry is the only way the turn completes.
const CAPACITY_STATUS_CODES = new Set([503, 529]);

const CONTEXT_OVERFLOW_PATTERNS = [
  /context (window|length)/i,
  /too many tokens/i,
  /maximum context/i,
  /prompt is too long/i,
  /request too large/i,
  /input length/i,
];

const AUTH_PATTERNS = [
  /invalid api key/i,
  /unauthorized/i,
  /not authenticated/i,
  /permission denied/i,
  /forbidden/i,
];

const ELIGIBLE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /rate[\s_-]?limit/i, label: "rate_limit" },
  { pattern: /too many requests/i, label: "too_many_requests" },
  { pattern: /\bquota\b/i, label: "quota" },
  { pattern: /usage limit/i, label: "usage_limit" },
  { pattern: /hit your session limit/i, label: "session_limit" },
  { pattern: /\bsession limit\b/i, label: "session_limit" },
  { pattern: /retry delay .*exceeded/i, label: "retry_delay_exceeded" },
  { pattern: /model_not_supported/i, label: "model_not_supported" },
  { pattern: /requested model .* not supported/i, label: "model_not_supported" },
  { pattern: /model .* is not supported/i, label: "model_not_supported" },
  { pattern: /unable to process your request/i, label: "capacity" },
  { pattern: /ServiceUnavailableException/i, label: "capacity" },
  { pattern: /service unavailable/i, label: "capacity" },
  { pattern: /\boverloaded\b/i, label: "capacity" },
];

export function classifyError(input: ClassifyInput): FallbackClassification {
  const { status, errorMessage } = input;
  const text = (errorMessage ?? "").trim();

  if (status !== undefined && AUTH_STATUS_CODES.has(status)) {
    return { eligible: false, reason: `auth_status_${status}` };
  }

  if (text) {
    for (const pattern of CONTEXT_OVERFLOW_PATTERNS) {
      if (pattern.test(text)) return { eligible: false, reason: "context_overflow" };
    }
    for (const pattern of AUTH_PATTERNS) {
      if (pattern.test(text)) return { eligible: false, reason: "auth_error" };
    }
  }

  if (status === 429) {
    return { eligible: true, reason: "http_429" };
  }
  if (status !== undefined && CAPACITY_STATUS_CODES.has(status)) {
    return { eligible: true, reason: `capacity_${status}` };
  }

  if (text) {
    for (const { pattern, label } of ELIGIBLE_PATTERNS) {
      if (pattern.test(text)) return { eligible: true, reason: label };
    }
  }

  return { eligible: false, reason: status ? `http_${status}` : "unknown" };
}
