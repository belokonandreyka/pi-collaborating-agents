# model-fallback

Pi extension that switches the orchestrator to the next model in a configured
chain when the current provider signals quota/rate exhaustion, and injects a
short continuation prompt so the new model resumes the task in place.

## When it fires

The extension listens for `agent_settled`. Pi's native retry loop
(`retryConfig`) runs **first** on transient failures inside a single turn.
Only after those retries give up and the turn ends with an error does
`agent_settled` fire — at which point this extension classifies the failure
and, if it looks like a quota / rate-limit condition on the current chain
entry, advances to the next entry.

Eligible signals (see `classify.ts`):

- HTTP 429
- Assistant `errorMessage` matching known quota / rate / usage-limit /
  session-limit (e.g. Claude Bridge `hit your session limit · resets 6pm`) /
  retry-delay phrases
- `model_not_supported` errors, so an unsupported registered fallback can
  advance to the next chain entry

Explicitly **not** eligible (bail out, keep current model):

- Context-window overflow
- Auth / 401 / 403
- Generic model-not-found / invalid-request errors other than
  `model_not_supported`
- Generic 5xx without a quota hint

## Runtime requirement

`agent_settled` is emitted by `@earendil-works/pi-coding-agent >= 0.74`
(verified in this workspace against `earendil 0.80.10`). The local peer
typings still resolve to `@mariozechner/pi-coding-agent@0.73.1`, which
predates the event; the extension casts through a compatibility shape to
register the handler without forcing a peer-dep bump. Older Pi runtimes
that do not emit `agent_settled` are **not** supported — the handler will
register but never fire.

Pi has no `retryLastTurn` API, so the continuation is delivered as a
`customType` context message via `pi.sendMessage(..., { triggerTurn: true,
deliverAs: "followUp" })`. The dispatch is deferred to a macrotask
(`setTimeout(..., 0)`) so it runs **after** the current `agent_settled`
handler fully unwinds; otherwise the nested `_runAgentPrompt` would re-enter
while `switchingInFlight` is still set and swallow a second consecutive
failure.

## Configuration

Two JSON files, merged in order (project overrides global):

1. Global: `~/.pi/agent/model-fallback.json`
2. Project: `<cwd>/.pi/model-fallback.json`

Config is (re)loaded on every `session_start` using `ctx.cwd`, so project
overrides follow `/resume` and session switches correctly.

### Schema

| Key                | Type                  | Default  | Notes                                                                          |
| ------------------ | --------------------- | -------- | ------------------------------------------------------------------------------ |
| `enabled`          | `boolean`             | `false`  | Master switch. When `false`, `agent_settled` is a no-op.                       |
| `orchestratorOnly` | `boolean`             | `true`   | If `true`, the controller stays dormant in subagent sessions (see below).      |
| `chain`            | `string[]`            | `[]`     | Ordered chain entries as `"<provider>/<model-id>"`. First matching entry is the anchor. |
| `resumeText`       | `string`              | built-in | Text of the injected continuation message.                                     |
| `notifyUser`       | `boolean`             | `true`   | Emit UI notifications on switch / skip / exhaustion.                           |
| `contextWarnings`  | `object[]`            | `[]`     | Per-entry context-size hazards; see below.                                     |

### `contextWarnings`

Each item is `{ "entry": "<provider>/<model-id>", "aboveTokens": <number>, "text": "<optional>" }`.
When the chain switches onto `entry` and the context size Pi reports is
strictly above `aboveTokens`, a warning naming the model, the observed context
and the threshold is emitted — the case where a fallback provider's window is
smaller than the current context (auto-compaction) or where the request lands
in a long-context pricing tier. Like the billing notice, it ignores
`notifyUser: false`; it stays silent whenever Pi cannot report a trustworthy
context size (e.g. right after a compaction).

```json
{
  "contextWarnings": [{ "entry": "openai-codex/gpt-5.6-sol", "aboveTokens": 270000 }]
}
```

### Concrete chain (recommended)

```json
{
  "enabled": true,
  "orchestratorOnly": true,
  "chain": [
    "claude-bridge/claude-opus-4-8",
    "github-copilot/claude-opus-4.7",
    "openai-codex/gpt-5.6-sol"
  ]
}
```

Resolved to: Claude Bridge Opus 4.8 → GitHub Copilot Opus 4.7 →
openai-codex GPT-5.6 Sol. The `provider` and `model-id` strings must match
what Pi's model registry exposes (`ctx.modelRegistry.find(provider, id)`).
Unregistered or unauthorized entries are skipped with a warning; the
controller scans forward to the next available entry.

## Behavior notes

- **Anchor position**: the current model must appear somewhere in `chain`.
  If it does not, the controller returns `not-in-chain` and does nothing —
  the extension will not hijack models it does not manage.
- **Stays on fallback after success**. Once a fallback wins, that model
  becomes the new anchor and the chain continues *from there*; a later
  success does not rewind to the top. No cycling back.
- **Exhaustion**: once the tail of the chain also fails, the controller
  emits a single warning and stops trying until state is manually reset.
- **Reentrant cascades**: if the follow-up turn on the fallback provider
  itself 429s, its `agent_settled` fires with a clean controller (the prior
  handler already released `switchingInFlight` and cleared the pending
  error before the deferred dispatch ran), so the chain keeps advancing.
- **`orchestratorOnly`**: evaluated per `session_start`. Subagent sessions
  detect themselves via `PI_COLLAB_SUBAGENT_DEPTH > 0` (set by the
  `collaborating-agents` extension). Handlers remain registered — only the
  controller reference is left `undefined`, so nothing dispatches.

## Known limitations

- The classifier is deliberately conservative. Body-level errors returned
  under HTTP 200 with no quota-style text will not trigger a switch.
- The continuation prompt is a plain context message. Providers that
  penalize repeated context reads may charge extra tokens on the fallback
  turn.
- One-shot `--print` mode exits after the initial prompt settles and may not
  wait for the deferred continuation timer. The supported target is a
  long-lived TUI or RPC session; RPC fallback is covered by an end-to-end
  smoke test during development.
