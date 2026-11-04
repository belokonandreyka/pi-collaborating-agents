import * as fs from "node:fs";
import * as path from "node:path";
import { resolveProfileAgentDir } from "./paths.js";

/**
 * A temporary model remap for subagent spawns, written by another extension
 * (copilot-pace writes one when a day's Copilot spend goes over its budget).
 *
 * `<agentDir>/state/model-route.json`:
 *   { "until": <epoch ms>, "reason": "...",
 *     "models": { "github-copilot/claude-opus-5.5": "vitu-gateway/claude-opus-5-5",
 *                 "github-copilot/gemini-3.8-flash": { "model": "vitu-gateway/claude-haiku-4-5", "reasoning": "low" } } }
 *
 * Only a type whose `model` is a key is remapped, and only before `until`.
 * A missing, expired or unreadable file changes nothing.
 */
export interface RoutedModel {
  model: string | undefined;
  reasoning: string | undefined;
  /** The type's own model when the route replaced it. */
  routedFrom?: string;
  reason?: string;
}

export function modelRouteFile(): string {
  return path.join(resolveProfileAgentDir(), "state", "model-route.json");
}

export function routeModel(
  model: string | undefined,
  reasoning: string | undefined,
  now = Date.now(),
  file = modelRouteFile(),
): RoutedModel {
  if (!model) return { model, reasoning };
  let route: any;
  try {
    route = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return { model, reasoning };
  }
  if (typeof route?.until !== "number" || now >= route.until) return { model, reasoning };
  const target = route.models?.[model];
  const reason = typeof route.reason === "string" ? route.reason : undefined;
  if (typeof target === "string" && target.trim()) return { model: target.trim(), reasoning, routedFrom: model, reason };
  if (target && typeof target.model === "string" && target.model.trim()) {
    const r = typeof target.reasoning === "string" && target.reasoning.trim() ? target.reasoning.trim() : reasoning;
    return { model: target.model.trim(), reasoning: r, routedFrom: model, reason };
  }
  return { model, reasoning };
}
