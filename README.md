# Collaborating Agents: An Extension for the Pi Coding Agent

This is an extension for Pi for spawning subagents, and for them to reserve files and send/receive messages to one another.

All sessions auto-register immediately when they start; so when a new Pi session is started, it is already part of the collaborating agents system.

## Quick Start

Install this extension and its included skill using **either** npm (recommended) or the git URL.

### Option 1: Install from npm

```bash
pi install npm:@baochunli/pi-collaborating-agents
```

### Option 2: Install from git URL

```bash
pi install https://github.com/baochunli/pi-collaborating-agents
```

Use the command:

```bash
pi config
```

To confirm that the `collaborating-agents` extension and the `collaborating-agents-system` skill have been activated. Use `Esc` to leave the configuration session.

To uninstall this extension:

```bash
pi remove npm:@baochunli/pi-collaborating-agents
```

or (if you installed using git URL):

```bash
pi remove https://github.com/baochunli/pi-collaborating-agents
```


## Setting up `AGENTS.md`

Use `pi config` to activate both the `pi-collaborating-agents` extension and the `collaborating-agents-system` skill, and (optionally) add the following to `AGENTS.md` for more specific instructions.

```text
Before handling the task, first learn the `collaborating-agents-system` skill. Use it to understand the available collaboration capabilities, including:

- spawning and coordinating subagents
- parallelizing suitable tasks
- sending direct and broadcast messages between agents
- reserving and releasing files/directories before edits

Then execute the task under these rules:

1. Prefer parallelism for read-heavy exploration and review tasks.
2. Reserve files/directories before any write.
3. Keep process logging single-writer when possible.
4. Use direct messages for blockers and decisions.
5. Use broadcasts for shared status updates.
6. Prefer low-coupling task decomposition; avoid conflicting parallel edits.

Choose an appropriate split of work, coordinate subagents carefully, and keep the execution process organized and auditable.
```

## Opening the _Agents and Messages_ Overlay with the `/agents` Command

The `/agents` slash command opens an integrated _agents and messages_ overlay with four tabs:

  - `Agents` tab contains a list of all active and recently completed agents, and it allows the user to switch to the selected active session and tracks the target session in real time.
  - `Feed` tab shows recent message activity across agents.
  - `File reservations` tab shows active reservation patterns and which agent currently owns each one.
  - `Chat` tab provides a shared chat stream and input box for `@all` broadcasts and direct `@AgentName` messages.

Newly-started agents show up immediately; if their transcript file is not persisted yet they are marked `session pending`. Completed subagents remain visible in the `Agents` tab as `completed` until the next time an orchestrator agent spawns new subagents, which clears prior historical completed-subagent entries from that list.

Messaging input is available in the `Chat` tab. Use `@AgentName message` for direct messages or `@all message` for broadcast. Prefix the message body with `!!` to mark it urgent.

Examples:

- Direct: `@BlueFalcon Status update: parsing complete.`
- Direct + urgent: `@BlueFalcon !! Need your decision now.`
- Broadcast: `@all Wave 2 complete.`
- Broadcast + urgent: `@all !! Stop edits in src/server/ until migration finishes.`

## Spawning a subagent via the `/subagent` command

The user can spawn a single subagent manually using the `/subagent [type] <task>` slash command. By default it runs as a background child process, but you can switch it to a visible cmux pane with `subagentLaunchMode`. When no type is specified, the extension resolves the default subagent type (`worker`/`default`) using the normal override order described below. In slash-command usage, the first token is treated as a type only if it matches a known subagent type; otherwise the full input is treated as the task. All agents use readable two-word callsigns (for example: `SilverHarbor`). An immediate `Spawning subagent ...` status message with runtime name and prompt will be shown immediately.

If you want spawned agents to appear in a visible cmux pane instead of only running as background child processes, set `subagentLaunchMode` to `"cmux-pane"` in your collaborating-agents config. That mode uses `cmux new-split` plus `cmux send`, then launches a real `pi` session directly in the new pane so you see Pi's own terminal output there while the orchestrator still collects the final subagent response automatically. The extension now applies a two-phase layout strategy: it first chooses a balanced split target from the current managed pane tree (optionally preserving the orchestrator's initial half with `preserveOrchestratorPane`), then runs a best-effort reconciliation pass with `cmux list-panes`, `cmux list-pane-surfaces`, `cmux move-surface`, and `cmux reorder-surface` so existing managed surfaces are moved back into the intended panes if the workspace drifted. This mode must be invoked from a Pi session that is already running inside a cmux terminal surface; otherwise subagent launch fails.

### Usage

```bash
# Use default subagent type
/subagent "Implement user authentication"

# Use a specific subagent type
/subagent scout "Find all TypeScript files in the project"
/subagent documenter "Write API documentation for the auth module"
/subagent reviewer "Check for security issues in src/auth/"
```

The parent (orchestrator agent) sessions automatically collect final subagent outputs on completion (single and parallel), without requiring subagents to send a separate final direct message summary. All direct subagent → parent status messages are optional, but are useful for blockers/questions only. Inbox delivery uses Pi's message routing: normal messages are queued with `followUp`, and `urgent: true` messages interrupt immediately with `steer`.

## Autonomous Tool API for Agents

The following tools are provided for agents to call autonomously. Users should use the slash commands above.

### The `agent_message` Tool

The extension provides a dedicated **`agent_message`** tool for autonomous agent-to-agent messaging.

Actions:

- `status` – current identity, focus mode, peer count, and your reservation count
- `list` – list active agents (includes reservation counts when present)
- `sessions` – list scoped subagent run/session records; completed/failed are included by default, set `includeCompleted: false` for active runs only
- `session` – resolve one subagent run/session record
- `tail` – read a concise transcript tail for one resolved subagent run/session
- `send` – send direct message (`to` + `message`, optional `replyTo`, optional `urgent`)
- `broadcast` – send to all active peers (`message`, optional `urgent`)
- `feed` – recent global message log (`limit` optional)
- `thread` – direct-message thread with one peer (`to`, `limit` optional)
- `reserve` – reserve files/directories for write/edit coordination (`paths`, optional `reason`)
- `release` – release reservations (`paths` optional; omit to release all)

Reservation patterns are validated. Empty patterns are rejected, and broad patterns (for example `.`, `/`, `./`, `../`, or a top-level directory like `src/`) are allowed but return warnings.

Examples:

```ts
agent_message({ action: "list" })
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "subagent-run-id" })
agent_message({ action: "tail", runId: "subagent-run-id" })
agent_message({ action: "tail", to: "latest" })
agent_message({ action: "send", to: "BlueFalcon", message: "I finished parsing" })
agent_message({ action: "send", to: "BlueFalcon", message: "Following up on your last note", replyTo: "msg-123" })
agent_message({ action: "send", to: "BlueFalcon", message: "Need your decision now", urgent: true })
agent_message({ action: "broadcast", message: "Wave 2 complete" })
agent_message({ action: "thread", to: "BlueFalcon", limit: 10 })
agent_message({ action: "reserve", paths: ["src/server/", "src/routes/account.tsx"], reason: "auth refactor" })
agent_message({ action: "release", paths: ["src/server/"] })
agent_message({ action: "release" })
```

### Subagent Session Inspection

Coordinators should inspect spawned subagents with `agent_message` instead of searching transcript files directly. Do not scan `~/.pi/agent/sessions` manually for normal subagent inspection; use the run registry so selectors stay scoped to the current coordinator.

Common calls:

```ts
agent_message({ action: "sessions" })
agent_message({ action: "sessions", includeCompleted: false })
agent_message({ action: "session", runId: "subagent-run-id" })
agent_message({ action: "tail", runId: "subagent-run-id" })
agent_message({ action: "tail", to: "latest" })
```

Selectors accepted by `session` and `tail`:

- child run id / `recordId`: the stable per-child id returned by `subagent` and launch notices
- display name: the readable subagent name shown in launch/completion output
- canonical name: the runtime subagent name recorded by the extension
- batch id: accepted only when it resolves to one child; parallel batches are ambiguous and return candidates
- session id prefix: matches the reported Pi session id prefix
- `latest`: newest subagent run for the current coordinator

`sessions` lists active, completed, and failed records for the current coordinator by default. Pass `includeCompleted: false` to show only launching/running runs. `session` returns run metadata, session id, session file status, launch mode, cwd, and task preview. `tail` reads and formats the resolved session JSONL tail; it rejects raw file paths so agents do not bypass selector scoping.

#### Delta `tail`, hard 3 KB cap, and status-first mode

`tail` responses include a `nextOffset` — the byte offset the reader is caught up to in the underlying session JSONL. Pass it back as `sinceOffset` on the next call to receive only new bytes (HTTP-Range / Kafka-consumer semantics; no server cursor):

```ts
const first = agent_message({ action: "tail", runId: "run-id" });
const delta = agent_message({ action: "tail", runId: "run-id", sinceOffset: first.details.nextOffset });
```

Stale, out-of-range, or negative `sinceOffset` values transparently resync to a tail-from-end read and return a fresh `nextOffset` plus `resynced: true`; one call restores the stream.

Every `tail` payload is clamped to ~3 KB (`TAIL_HARD_CAP_BYTES`) regardless of any caller-requested size. This applies to both tail-from-end and delta reads; oversized responses drop the earliest bytes (`truncatedStart: true`).

For cheap polling that does not need the transcript, pass `mode: "status"`:

```ts
agent_message({ action: "tail", runId: "run-id", mode: "status" })
```

Returns only the run status plus, when the run is finished, the structured final report already captured in the run registry (`outputPreview`, `exitCode`, `completedAt`, `warnings`) — no session file read.

Process-mode subagents are launched as background `pi` child processes without a deterministic `--session` file. The extension records the session id from child output and attaches a session file only after child self-registration or fallback discovery by session id. Until then, tailing can report: `Process-mode session file unavailable until child registration or fallback discovery provides one.` In `cmux-pane` mode, the extension creates an explicit session file under `~/.pi/agent/sessions/collaborating-agents-subagents/` and tails that file after it appears.

### The `subagent` Tool

The extension also provides a lightweight **`subagent`** tool for agents to call when they need to spawn subagents.

Modes:

- Single: `{ task }` or `{ type, task }`
- Parallel: `{ tasks: [{ task, cwd? }, ...] }` or `{ type, tasks: [...] }`

Parameters:

- `task` (string, optional) – Task prompt for single-mode
- `tasks` (array, optional) – Array of task objects for parallel-mode
- `type` (string, optional) – Subagent type to use (e.g., "scout", "documenter", "reviewer")
- `cwd` (string, optional) – Working directory for spawned subagents

Examples:

```ts
// Default subagent type
subagent({ task: "Implement auth tags and report back via agent_message" })

// With specific subagent type
subagent({
  type: "scout",
  task: "Find all TypeScript files in the project"
})

// Parallel subagents
subagent({
  tasks: [
    { task: "Implement backend pieces" },
    { task: "Implement frontend pieces" }
  ]
})

// Parallel with specific type (applies to all tasks)
subagent({
  type: "documenter",
  tasks: [
    { task: "Document backend API" },
    { task: "Document frontend components" }
  ]
})
```

Launch responses and background launch notices include a Batch ID plus one child Run ID per spawned subagent. Prefer those Run IDs for `agent_message({ action: "session", runId: "..." })` and `agent_message({ action: "tail", runId: "..." })`; use `agent_message({ action: "sessions" })` to rediscover active and recent completed runs, or `includeCompleted: false` for active runs only.

## Subagent Type Configuration

You can define custom subagent types using TOML configuration files. These allow you to create specialized subagents with different prompts, models, and reasoning levels.

### Configuration locations

Subagent type configurations are loaded in precedence order (later entries override earlier ones when names match):

1. **Bundled defaults**: `examples/subagents/*.toml` (included with this extension)
2. **User overrides**:
   - Legacy: `~/.pi/agent/subagents/*.toml`
   - Also supported: `~/.pi/subagents/*.toml`
   - Preferred: `~/.pi/agents/*.toml`
3. **Project overrides** (nearest ancestor from current cwd):
   - Legacy: `.pi/subagents/*.toml`
   - Preferred: `.pi/agents/*.toml`

If no override directory contains a matching type, the extension falls back to the included `examples/subagents` configuration files.

### TOML format

Each `.toml` file defines one subagent type:

```toml
name = "scout"
description = "Exploration specialist for finding files and patterns"

# Optional: Override the model (defaults to parent session's model)
model = "openai/gpt-4o-mini"

# Optional: Set reasoning level (low, medium, high, xhigh)
reasoning = "low"

# Required: The system prompt for this subagent type
prompt = """You are a Scout subagent specialized in exploration...

## Guidelines
- Be quick and focused
- Use bash, find, grep efficiently
- Report findings in structured format
"""
```

### Default subagent type

When no type is specified, the extension resolves the default in this order:

1. the highest-precedence non-bundled `worker.toml` override found in user/project directories
2. otherwise the highest-precedence non-bundled `default.toml` override found in user/project directories
3. bundled discovered `worker`
4. bundled `examples/subagents/worker.toml`
5. Emergency inline fallback (only if bundled files are unavailable)

To customize the default behavior, create `worker.toml` in one of the supported user or project override directories.

### Example subagent types

The extension includes example configurations for common use cases:

| Type | Purpose | Reasoning |
|------|---------|-----------|
| `worker` | General-purpose development tasks | medium |
| `scout` | Exploration and discovery | low |
| `documenter` | Documentation writing | medium |
| `reviewer` | Code review and analysis | high |

See the `examples/subagents/` directory for complete example configurations.

### Using subagent types

**Via slash command:**
```bash
/subagent scout "Find all API endpoints in src/"
/subagent documenter "Write README for the auth module"
/subagent reviewer "Check src/auth.ts for security issues"
```

**Via the `subagent` tool:**
```ts
// Single subagent with type
subagent({
  type: "scout",
  task: "Find all TypeScript files"
})

// Parallel subagents with types
subagent({
  tasks: [
    { task: "Document auth module" },  // uses default/worker type
    { task: "Review auth module" }     // uses default/worker type
  ],
  type: "documenter"  // applies to all tasks
})
```

## Configuration

This extension supports both **JSON config files** and **environment variables**.

### Configuration file locations and precedence

The extension loads and merges configuration in this order:

1. Built-in defaults
2. Global config: `~/.pi/agent/collaborating-agents.json`
3. Project config: `<cwd>/.pi/collaborating-agents.json` (overrides global)

Invalid config values fall back to defaults. Numeric fields such as `messageHistoryLimit` must be positive.

### Config keys

#### `messageHistoryLimit` (number, default: `400`)

Default history depth used by the overlay feed/chat loader.

- Larger values allow more history at once but increase read/format work.
- Smaller values keep UI snappier in very high-message sessions.

This is a default baseline; runtime calls may still request larger limits.

#### `subagentLaunchMode` (`"process" | "cmux-pane"`, default: `"process"`)

Controls how spawned subagents are launched.

- `"process"` keeps the current behavior: spawn a background `pi` child process directly.
- `"cmux-pane"` launches the subagent in a new visible cmux split pane in the current workspace by calling `cmux new-split` and then sending a real `pi` launch command into that pane.
- In `"cmux-pane"` mode, the extension tracks the orchestrator pane plus visible subagent panes in the workspace and picks the shallowest managed pane for the next split (preferring subagent panes over the orchestrator on ties). It alternates horizontal and vertical split directions by tree depth so the layout trends toward a balanced grid instead of repeatedly slicing columns off the orchestrator pane.
- Set `preserveOrchestratorPane` to `true` to reserve the orchestrator's initial half: the first child splits the orchestrator, then later children balance only among live subagent leaves. If every subagent pane has closed, the next child falls back to splitting the orchestrator again.
- After each new pane is created, the extension also snapshots live cmux panes/surfaces and performs a best-effort rebalance pass. If managed surfaces drifted because of manual pane moves or closes, it uses `move-surface`/`reorder-surface` to restore the planned arrangement before continuing. Preserved layouts never move a subagent surface into the orchestrator pane.

Use `"cmux-pane"` when you want every spawned agent to have a real visible terminal in cmux while still preserving automatic result collection in the parent session. The pane shows Pi's native terminal session output instead of a custom JSON renderer.

By default, successfully completed `"cmux-pane"` subagents are auto-closed after the orchestrator has collected their final output and the pane has stayed idle for a short grace period. If the pane reports a non-zero post-output exit during that grace period, or if close/idle detection fails, the pane is left open so you can inspect diagnostics.

`"cmux-pane"` requires the orchestrator itself to be running inside cmux so the extension can split the current workspace.

Example:

```json
{
  "subagentLaunchMode": "cmux-pane",
  "preserveOrchestratorPane": true,
  "closeCompletedCmuxPanes": true
}
```

#### `preserveOrchestratorPane` (boolean, default: `false`)

Controls whether the orchestrator keeps the half created by the first cmux split.

- `false` preserves the legacy balancing strategy across all managed leaves.
- `true` allows the first child to split the orchestrator, then selects later split targets only from live subagent leaves using the same depth/order balancing. When no subagent leaf remains after automatic or manual closes, selection falls back to the orchestrator.

Snapshot reconciliation and split retries follow the same boundary: subagent surfaces are not moved into the orchestrator pane, and a failed subagent target retries another live subagent leaf before falling back.

This setting only affects `"cmux-pane"` launch mode.

#### `closeCompletedCmuxPanes` (boolean, default: `true`)

Controls whether successfully completed `"cmux-pane"` subagents automatically close their terminal surface after the parent orchestrator has collected the final output and the pane has remained idle for a short grace period.

- `true` closes successful completed panes by calling `cmux close-surface --surface <ref>` after turn-finished output plus a short idle grace.
- `false` keeps completed panes open for manual inspection.

This setting only affects `"cmux-pane"` launch mode. Failures or non-zero exits detected during the idle grace leave panes open so logs remain visible.

#### `subagentProgressIntervalMs` (number, default: `30000`)

Minimum gap, per child, between progress updates posted to the orchestrator while a subagent is still running. Set to `0` to disable progress updates entirely.

Without this, the orchestrator learns nothing about a child until the child finishes: the pane shows live activity to the human, but the parent's context stays empty. Each update is one compact line naming the child's callsign, how many tool calls it has made, and which tool it is running now.

Updates travel through the same delivery queue as completions, so they wait for the parent to be idle and never trigger a turn on their own — the orchestrator reads accumulated progress on its next turn rather than being interrupted. The interval is what keeps a fleet of children from flooding the parent's context; lower it for closer monitoring at the cost of tokens.

This setting only affects `"cmux-pane"` launch mode, which is the only mode that watches a child session file while it runs.

Set it to `0` together with `subagentLaunchDisplay: "hidden"` when you want no launch, session-ready, or progress messages rendered.

#### `subagentLaunchDisplay` (`"full" | "compact" | "hidden"`, default: `"full"`)

Controls the custom launch message posted after each child starts.

- `"full"` preserves the existing verbose launch block, including the task, runtime prompt, session metadata, and inspection hints.
- `"compact"` shows only the display name, profile, batch/run IDs, working directory, launch mode, and inspection hints.
- `"hidden"` suppresses the verbose launch update and related session-ready notice entirely; `pi.sendMessage` is not called for either notice.

This setting does not hide the `subagent` tool result returned to the coordinator, and durable run/session records remain available through `agent_message`. Progress remains independently controlled by `subagentProgressIntervalMs`.

#### `subagentCompletionDisplay` (`"full" | "hidden"`, default: `"full"`)

Controls rendering of the final auto-collected subagent result.

- `"full"` preserves the existing visible final completion message.
- `"hidden"` sends only a concise custom-message wake token with `display: false`. The token includes child Run IDs and directs the coordinator to `agent_message({ action: "session", runId })` and `agent_message({ action: "tail", runId })`; it never embeds the child final report.

Full output and failure detail remain in the durable run/session registry. This setting applies only to final completion and failure messages. Launch and session-ready behavior is controlled by `subagentLaunchDisplay`, while progress remains independently configured.

#### `triggerTurnOnSubagentCompletion` (boolean, default: `false`)

When `true`, a deliverable final completion is sent with `triggerTurn: true` once the coordinator is idle. The default remains `false` for compatibility. In hidden completion mode, the triggered coordinator turn must inspect the Run IDs from the wake token with `agent_message` `session` / `tail` to retrieve the result.

With automatic turn triggering enabled, subagents do not need to send an urgent completion DM merely to wake the coordinator. Avoid using both mechanisms for the same completion because they can race and start competing coordinator turns.

A quiet auto-resume configuration is:

```json
{
  "subagentLaunchDisplay": "hidden",
  "subagentProgressIntervalMs": 0,
  "subagentCompletionDisplay": "hidden",
  "triggerTurnOnSubagentCompletion": true
}
```

The coordinator receives no launch or session-ready custom messages. Completion sends one minimal wake token; inspect its Run ID(s) through the durable session registry for the full result.

### Environment variables

#### `COLLABORATING_AGENTS_DIR`

Overrides the storage root used by the extension. Default:

- `~/.pi/agent/collaborating-agents`

This affects:

- `registry/` (active agent registrations)
- `inbox/` (per-agent inbound queue)
- `runs/` (durable subagent run/session records)
- `messages.jsonl` (global append-only message log)

Use this to isolate per-project state or relocate agent data.

#### `PI_AGENT_NAME`

Forces an explicit runtime agent name instead of auto-generated names.

Useful for deterministic scripts/tests or named coordinator sessions.

#### `PI_COLLAB_SUBAGENT_DEPTH` and `PI_COLLAB_SUBAGENT_MAX_DEPTH`

Recursion guard for nested subagent spawning.

- `PI_COLLAB_SUBAGENT_DEPTH` tracks current depth.
- `PI_COLLAB_SUBAGENT_MAX_DEPTH` sets max allowed depth (default max is `2`).

If `depth >= max`, subagent spawn is blocked.

## How It Works

Messages use Pi's delivery system: normal messages queue until the recipient finishes their current turn, urgent ones interrupt immediately. No polling is needed.

Reservations are enforced by hooking Pi's edit and write tools. When an agent tries to edit a reserved file, the tool call gets blocked and the agent sees who reserved it, why, and a suggestion to coordinate via the `agent_message({ action: "send", ... })` tool. Write and edit calls are blocked when another active agent has a matching reservation. Reads remain allowed.

States in this extension are stored at `~/.pi/agent/collaborating-agents/`:

```
.pi/agent/collaborating-agents/
├── registry/          # One JSON file per agent
├── inbox/{name}/      # Inbound messages as JSON files, watched with fs.watch, one directory for each agent
├── runs/              # Durable subagent run/session records, one JSON file per child run
└── messages.jsonl     # Append-only log of all messages in the system
```

## Validation

Use `bun test` for implementation and docs validation. Useful focused checks for the subagent session inspection surface:

```bash
bun test extensions/collaborating-agents/docs.test.ts
bun test extensions/collaborating-agents/index.test.ts --test-name-pattern "tool documentation metadata|agent_message subagent sessions|subagent launch identity"
bun test extensions/collaborating-agents/session-tail.test.ts
bun test
npm pack --dry-run
```

Keep `npm pack --dry-run` as the packaging check before publishing or validating package contents.

Manual smoke: process mode

1. Use default `subagentLaunchMode: "process"` and spawn a single subagent.
2. Confirm the launch notice shows Batch ID, Run ID, runtime name, and session status.
3. Run `agent_message({ action: "sessions" })`, then `agent_message({ action: "session", runId: "<run-id>" })`.
4. Run `agent_message({ action: "tail", runId: "<run-id>" })`; if the session file is still unavailable, confirm the process-mode unavailable reason is shown.

Manual smoke: parallel ambiguity

1. Spawn at least two parallel subagents in one batch.
2. Run `agent_message({ action: "session", runId: "<batch-id>" })` and confirm it reports an ambiguous selector with candidate child Run IDs.
3. Run `agent_message({ action: "tail", runId: "<child-run-id>" })` for a specific child.

Manual smoke: cmux mode

1. When running inside cmux, set `subagentLaunchMode: "cmux-pane"` and spawn a subagent.
2. Confirm a visible pane opens and the launch/session-ready notices include a session file.
3. Run `agent_message({ action: "tail", runId: "<run-id>" })` and confirm it tails the cmux session file.
