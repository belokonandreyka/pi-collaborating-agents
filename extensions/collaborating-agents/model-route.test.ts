import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeModel } from "./model-route.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function routeFile(route: unknown): string {
  dir = mkdtempSync(join(tmpdir(), "model-route-"));
  const file = join(dir, "model-route.json");
  writeFileSync(file, JSON.stringify(route));
  return file;
}

describe("routeModel", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const route = {
    until: now + 3600_000,
    reason: "over today's budget",
    models: {
      "github-copilot/claude-opus-5.5": "vitu-gateway/claude-opus-5-5",
      "github-copilot/gemini-3.8-flash": { model: "vitu-gateway/claude-haiku-4-5", reasoning: "low" },
    },
  };

  test("a mapped type goes to the target until the route expires", () => {
    const file = routeFile(route);
    expect(routeModel("github-copilot/claude-opus-5.5", "medium", now, file)).toEqual({
      model: "vitu-gateway/claude-opus-5-5",
      reasoning: "medium",
      routedFrom: "github-copilot/claude-opus-5.5",
      reason: "over today's budget",
    });
    expect(routeModel("github-copilot/gemini-3.8-flash", "medium", now, file).reasoning).toBe("low");
    expect(routeModel("github-copilot/claude-opus-5.5", "medium", route.until, file).model).toBe("github-copilot/claude-opus-5.5");
  });

  test("an unmapped model, a missing file or no model stay as they are", () => {
    const file = routeFile(route);
    expect(routeModel("vitu-gateway/claude-opus-5", "high", now, file)).toEqual({ model: "vitu-gateway/claude-opus-5", reasoning: "high" });
    expect(routeModel("github-copilot/claude-opus-5.5", "medium", now, join(file, "nope"))).toEqual({ model: "github-copilot/claude-opus-5.5", reasoning: "medium" });
    expect(routeModel(undefined, "low", now, file)).toEqual({ model: undefined, reasoning: "low" });
  });
});
