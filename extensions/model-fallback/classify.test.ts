import { describe, expect, test } from "bun:test";
import { classifyError } from "./classify.ts";

describe("classifyError", () => {
  test("should mark HTTP 429 as eligible even without a message body", () => {
    const result = classifyError({ status: 429 });
    expect(result.eligible).toBe(true);
    if (result.eligible) expect(result.reason).toBe("http_429");
  });

  test("should mark quota and rate-limit text as eligible", () => {
    expect(classifyError({ errorMessage: "You have exceeded your quota." }).eligible).toBe(true);
    expect(classifyError({ errorMessage: "rate limit reached" }).eligible).toBe(true);
    expect(classifyError({ errorMessage: "Too Many Requests" }).eligible).toBe(true);
    expect(
      classifyError({ errorMessage: "usage limit for this key was hit" }).eligible,
    ).toBe(true);
    expect(
      classifyError({ errorMessage: "retry delay of 60s exceeded" }).eligible,
    ).toBe(true);
  });

  test("should mark model_not_supported errors as eligible so bad chain entries advance", () => {
    expect(classifyError({ errorMessage: "model_not_supported" }).eligible).toBe(true);
    expect(
      classifyError({ errorMessage: "The requested model gpt-9 is not supported" }).eligible,
    ).toBe(true);
  });

  test("should mark Claude Bridge session-limit message as eligible", () => {
    expect(
      classifyError({
        errorMessage:
          "Claude Code returned an error result: You've hit your session limit \u00b7 resets 6pm (Europe/Kiev)",
      }).eligible,
    ).toBe(true);
    expect(classifyError({ errorMessage: "session limit reached" }).eligible).toBe(true);
  });

  test("should NOT fall back on auth failures", () => {
    expect(classifyError({ status: 401 }).eligible).toBe(false);
    expect(classifyError({ status: 403 }).eligible).toBe(false);
    expect(
      classifyError({ status: 401, errorMessage: "Invalid API key provided" }).eligible,
    ).toBe(false);
  });

  test("should NOT fall back on context overflow", () => {
    expect(
      classifyError({ errorMessage: "context window exceeded" }).eligible,
    ).toBe(false);
    expect(
      classifyError({ errorMessage: "prompt is too long for this model" }).eligible,
    ).toBe(false);
  });

  test("should NOT fall back on generic HTTP 500", () => {
    expect(classifyError({ status: 500 }).eligible).toBe(false);
    expect(
      classifyError({ status: 500, errorMessage: "Internal server error" }).eligible,
    ).toBe(false);
  });

  test("should NOT fall back when there is no status or error text", () => {
    expect(classifyError({}).eligible).toBe(false);
  });
});
