export type FallbackClassification =
  | { eligible: true; reason: string }
  | { eligible: false; reason: string };

export interface ClassifyInput {
  status?: number;
  errorMessage?: string;
}

const AUTH_STATUS_CODES = new Set([401, 403]);

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

  if (text) {
    for (const { pattern, label } of ELIGIBLE_PATTERNS) {
      if (pattern.test(text)) return { eligible: true, reason: label };
    }
  }

  return { eligible: false, reason: status ? `http_${status}` : "unknown" };
}
