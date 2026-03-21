# Symphony + Beads Service Specification

Status: Draft v1  
Purpose: Define a long-running orchestration service that reads ready work from `bd` (beads), creates an isolated workspace for each bead, and runs a coding agent session for that bead inside the workspace. This specification aligns the Symphony orchestration model with a bead-based work graph rather than a tracker like Linear. It preserves Symphony’s execution architecture while replacing tracker-driven candidate selection with bead-driven readiness.

---

## 1. Problem Statement

Symphony is a long-running automation service that continuously reads work from a bead graph (`bd`), creates an isolated workspace for each ready bead, and runs a coding agent session for that bead inside the workspace.

The service solves five operational problems:

- It turns bead execution into a repeatable daemon workflow instead of manual scripts.
- It isolates agent execution in per-bead workspaces so agent commands run only inside bead-specific workspace directories.
- It keeps workflow policy in-repo (`WORKFLOW.md`) so teams version the agent prompt and runtime settings with their code.
- It uses the bead graph as the source of truth for dependency-aware readiness.
- It provides enough observability to operate and debug multiple concurrent agent runs.

Important boundary:

- `bd` is the work graph and dependency engine.
- Symphony is the scheduler/runner and workspace orchestrator.
- Bead writes (status transitions, comments, metadata, discovered work, dependency creation) are typically performed by the coding agent using `bd` commands available in the runtime environment.
- A successful run may end at a workflow-defined handoff state, not necessarily bead closure.
- Symphony must not reimplement dependency reasoning already provided by `bd`; it should consume readiness from `bd`.

---

## 2. Goals and Non-Goals

### 2.1 Goals

- Poll `bd` on a fixed cadence and dispatch ready beads with bounded concurrency.
- Maintain a single authoritative orchestrator state for dispatch, retries, and reconciliation.
- Create deterministic per-bead workspaces and preserve them across runs.
- Stop active runs when bead state changes make them ineligible.
- Recover from transient failures with exponential backoff.
- Load runtime behavior from a repository-owned `WORKFLOW.md` contract.
- Expose operator-visible observability, at minimum structured logs.
- Support restart recovery without requiring a persistent orchestrator database.
- Allow agents to create new beads and link them into the graph during execution.

### 2.2 Non-Goals

- Rich web UI or multi-tenant control plane.
- Replacing `bd` as the system of record for work structure.
- Recomputing dependency graphs outside `bd`.
- Mandating a specific dashboard or terminal UI.
- General-purpose workflow engine or distributed job scheduler.
- Built-in business logic for how to mutate beads; that logic lives in the workflow prompt and agent tooling.
- Mandating a single approval, sandbox, or operator-confirmation posture.

---

## 3. System Overview

### 3.1 Main Components

1. **Workflow Loader**
   - Reads `WORKFLOW.md`.
   - Parses YAML front matter and prompt body.
   - Returns `{config, prompt_template}`.

2. **Config Layer**
   - Exposes typed getters for workflow config values.
   - Applies defaults and environment variable indirection.
   - Performs validation before dispatch.

3. **Bead Client**
   - Fetches ready beads.
   - Fetches bead details by identifier or ID for reconciliation.
   - Fetches closed beads during startup cleanup.
   - Normalizes `bd` payloads into a stable bead model.

4. **Orchestrator**
   - Owns the poll tick.
   - Owns the in-memory runtime state.
   - Decides which beads to dispatch, retry, stop, or release.
   - Tracks session metrics and retry queue state.

5. **Workspace Manager**
   - Maps bead identifiers to workspace paths.
   - Ensures per-bead workspace directories exist.
   - Runs workspace lifecycle hooks.
   - Cleans workspaces for terminal beads when configured.

6. **Agent Runner**
   - Creates workspace.
   - Builds prompt from bead + workflow template.
   - Launches the coding agent app-server client.
   - Streams agent updates back to the orchestrator.

7. **Status Surface** (optional)
   - Presents human-readable runtime status.

8. **Logging**
   - Emits structured runtime logs to one or more configured sinks.

### 3.2 Abstraction Levels

1. **Policy Layer**
   - `WORKFLOW.md` prompt body.
   - Team-specific rules for how agents interpret and mutate beads.

2. **Configuration Layer**
   - Parses front matter into typed runtime settings.
   - Handles defaults, environment tokens, and path normalization.

3. **Coordination Layer**
   - Polling loop, bead eligibility, concurrency, retries, reconciliation.

4. **Execution Layer**
   - Filesystem lifecycle, workspace preparation, coding-agent protocol.

5. **Integration Layer**
   - `bd` CLI or API adapter and normalization.

6. **Observability Layer**
   - Logs and optional status surface.

### 3.3 External Dependencies

- `bd` CLI or equivalent interface to the beads database.
- Local filesystem for workspaces and logs.
- Optional workspace population tooling such as Git CLI.
- Coding-agent executable that supports JSON-RPC-like app-server mode over stdio.
- Host environment authentication and local runtime tools as needed.

---

## 4. Core Domain Model

### 4.1 Entities

#### 4.1.1 Bead

Normalized bead record used by orchestration, prompt rendering, and observability output.

Fields:

- `id` (string)
  - Stable internal bead ID if available.
- `identifier` (string)
  - Human-readable bead key such as `bd-1` or `api-a3f2dd`.
- `title` (string)
- `description` (string or null)
- `priority` (integer or null)
  - Lower numbers are higher priority.
- `status` (string)
  - Current bead status, typically `open`, `in_progress`, or `closed`.
- `assignee` (string or null)
- `labels` (list of strings)
- `depends_on` (list of dependency refs)
  - Each dependency ref may contain:
    - `id` (string or null)
    - `identifier` (string or null)
    - `status` (string or null)
- `relation_summary` (map or null)
  - Optional counts or typed dependency relationships such as `blocks`, `related`, `parent-child`, `discovered-from`.
- `created_at` (timestamp or null)
- `updated_at` (timestamp or null)

#### 4.1.2 Workflow Definition

Parsed `WORKFLOW.md` payload:

- `config` (map)
- `prompt_template` (string)

#### 4.1.3 Service Config (Typed View)

Typed runtime values derived from `WorkflowDefinition.config` plus environment resolution.

Examples:

- poll interval
- workspace root
- active and terminal bead statuses
- concurrency limits
- coding-agent executable, args, and timeouts
- workspace hooks
- bead client command mode

#### 4.1.4 Workspace

Filesystem workspace assigned to one bead identifier.

Fields:

- `path`
- `workspace_key`
- `created_now`

#### 4.1.5 Run Attempt

One execution attempt for one bead.

Fields:

- `bead_id`
- `bead_identifier`
- `attempt` (integer or null, `null` for first run)
- `workspace_path`
- `started_at`
- `status`
- `error` (optional)

#### 4.1.6 Live Session

State tracked while a coding-agent subprocess is running.

Fields:

- `session_id`
- `thread_id`
- `turn_id`
- `codex_app_server_pid`
- `last_codex_event`
- `last_codex_timestamp`
- `last_codex_message`
- `codex_input_tokens`
- `codex_output_tokens`
- `codex_total_tokens`
- `last_reported_input_tokens`
- `last_reported_output_tokens`
- `last_reported_total_tokens`
- `turn_count`

#### 4.1.7 Retry Entry

Scheduled retry state for a bead.

Fields:

- `bead_id`
- `identifier`
- `attempt`
- `due_at_ms`
- `timer_handle`
- `error`

#### 4.1.8 Orchestrator Runtime State

Fields:

- `poll_interval_ms`
- `max_concurrent_agents`
- `running` (map `bead_id -> running entry`)
- `claimed` (set of bead IDs)
- `retry_attempts` (map `bead_id -> RetryEntry`)
- `completed` (set of bead IDs; bookkeeping only)
- `codex_totals`
- `codex_rate_limits`

### 4.2 Stable Identifiers and Normalization Rules

- **Bead ID**
  - Use for internal map keys and reconciliation if available.
- **Bead Identifier**
  - Use for human-readable logs, workspace naming, and agent instructions.
- **Workspace Key**
  - Derive from `bead.identifier` by replacing any character not in `[A-Za-z0-9._-]` with `_`.
- **Normalized Bead Status**
  - Compare after lowercase.
- **Session ID**
  - Compose as `<thread_id>-<turn_id>`.

---

## 5. Bead Semantics

### 5.1 Readiness Contract

A bead is considered ready if all are true:

- status is `open`
- it has no blocking dependencies that are not closed
- it is returned by `bd ready` or equivalent adapter logic

Normative rule:

- Symphony should prefer `bd ready --json` or an equivalent readiness-providing interface.
- Symphony must not independently recompute readiness if `bd` already provides it, except as a fallback when explicitly documented.

### 5.2 Status Mapping

Recommended conceptual mapping:

- `open` -> active candidate state
- `in_progress` -> active running state
- `closed` -> terminal state

Implementations may still dispatch `open` beads only, while treating `in_progress` as active during reconciliation if the agent or other operators move a bead into that state.

### 5.3 Dependency Types

`bd` may represent multiple relation types including:

- `blocks`
- `related`
- `parent-child`
- `discovered-from`

Dispatch gating should only depend on blocking dependencies, unless the workflow explicitly extends the policy.

### 5.4 Ownership Model

Symphony owns runtime execution state.  
`bd` owns graph structure and work state.

Symphony should not directly mutate bead state except through documented workflow actions or agent-issued `bd` commands.

---

## 6. Workflow Specification (Repository Contract)

### 6.1 File Discovery and Path Resolution

Workflow file path precedence:

1. Explicit application/runtime setting
2. Default: `WORKFLOW.md` in current working directory

Loader behavior:

- If the file cannot be read, return `missing_workflow_file`.
- The workflow file is expected to be repository-owned and version-controlled.

### 6.2 File Format

`WORKFLOW.md` is a Markdown file with optional YAML front matter.

Parsing rules:

- If file starts with `---`, parse lines until the next `---` as YAML front matter.
- Remaining lines become the prompt body.
- If front matter is absent, treat the entire file as prompt body and use an empty config map.
- YAML front matter must decode to a map/object.
- Prompt body is trimmed before use.

Returned workflow object:

- `config`
- `prompt_template`

### 6.3 Front Matter Schema

Top-level keys:

- `beads`
- `polling`
- `workspace`
- `hooks`
- `agent`
- `codex`

Unknown keys should be ignored for forward compatibility.

#### 6.3.1 `beads` (object)

Fields:

- `command` (string)
  - Default: `bd`
- `ready_args` (list of strings or command string)
  - Default equivalent to `ready --json`
- `show_args` (list of strings or command string)
  - Default equivalent to `show <id> --json`
- `list_args` (list of strings or command string)
  - Default equivalent to `list --json`
- `closed_statuses` (list of strings)
  - Default: `["closed"]`
- `active_statuses` (list of strings)
  - Default: `["open", "in_progress"]`
- `claim_on_dispatch` (boolean)
  - Default: `true`
- `claim_command_template` (string, optional)
  - Example: `bd update {{ bead.identifier }} --claim`
- `start_command_template` (string, optional)
  - Example: `bd update {{ bead.identifier }} --status in_progress`
- `close_command_template` (string, optional)
  - Typically used by the agent, not by the orchestrator
- `db_path` (string or `$VAR`, optional)

Notes:

- The orchestrator may use direct database access or CLI execution, but behavior must match this specification.
- If `claim_on_dispatch` is enabled and a claim command is configured, the orchestrator may mark the bead as claimed before agent launch.
- Status updates are usually performed by the agent rather than the orchestrator.

#### 6.3.2 `polling` (object)

Fields:

- `interval_ms`
  - Default: `30000`

#### 6.3.3 `workspace` (object)

Fields:

- `root`
  - Default: `<system-temp>/symphony_workspaces`

#### 6.3.4 `hooks` (object)

Fields:

- `after_create`
- `before_run`
- `after_run`
- `before_remove`
- `timeout_ms`
  - Default: `60000`

#### 6.3.5 `agent` (object)

Fields:

- `max_concurrent_agents`
  - Default: `10`
- `max_retry_backoff_ms`
  - Default: `300000`
- `max_turns`
  - Default: `20`
- `max_concurrent_agents_by_status`
  - Map `status_name -> positive integer`

#### 6.3.6 `codex` (object)

Fields:

- `command`
  - Default: `codex app-server`
- `approval_policy`
- `thread_sandbox`
- `turn_sandbox_policy`
- `turn_timeout_ms`
  - Default: `3600000`
- `read_timeout_ms`
  - Default: `5000`
- `stall_timeout_ms`
  - Default: `300000`

### 6.4 Prompt Template Contract

The Markdown body of `WORKFLOW.md` is the per-bead prompt template.

Rendering requirements:

- Use a strict template engine.
- Unknown variables must fail rendering.
- Unknown filters must fail rendering.

Template input variables:

- `bead`
  - Includes all normalized bead fields.
- `attempt`
  - `null` on first attempt, integer on retry or continuation.
- `workspace`
  - Optional object with workspace path information if the implementation exposes it.
- `runtime`
  - Optional minimal runtime metadata if the implementation exposes it.

Fallback prompt behavior:

- If the workflow prompt body is empty, the runtime may use a minimal default prompt:
  - `You are working on a bead from bd.`
- Workflow parse failures must not silently fall back.

### 6.5 Workflow Validation and Error Surface

Error classes:

- `missing_workflow_file`
- `workflow_parse_error`
- `workflow_front_matter_not_a_map`
- `template_parse_error`
- `template_render_error`

Dispatch gating behavior:

- Workflow file read/YAML errors block new dispatches until fixed.
- Template errors fail only the affected run attempt.

---

## 7. Configuration Specification

### 7.1 Source Precedence and Resolution Semantics

Configuration precedence:

1. Workflow file path selection
2. YAML front matter values
3. Environment indirection via `$VAR_NAME`
4. Built-in defaults

Value coercion semantics:

- Path fields support `~` and `$VAR` expansion.
- Command strings remain shell command strings.

### 7.2 Dynamic Reload Semantics

Dynamic reload is required:

- Watch `WORKFLOW.md` for changes.
- Re-read and re-apply config and prompt template without restart.
- Reloaded config applies to future dispatch, retry scheduling, reconciliation, hook execution, and agent launches.
- In-flight sessions need not restart automatically.
- Invalid reloads keep the last known good configuration and emit an operator-visible error.

### 7.3 Dispatch Preflight Validation

Startup validation:

- Validate configuration before starting scheduling loop.
- If startup validation fails, fail startup.

Per-tick validation:

- Re-validate before each dispatch cycle.
- If validation fails, skip dispatch for that tick, keep reconciliation active, and emit an error.

Validation checks:

- Workflow file can be loaded and parsed.
- `beads.command` is present and executable or otherwise available.
- `codex.command` is present and non-empty.
- Any configured database path or environment-backed bead settings resolve correctly.

### 7.4 Config Fields Summary

- `beads.command`: string, default `bd`
- `beads.ready_args`: command args or equivalent, default `ready --json`
- `beads.show_args`: default `show <id> --json`
- `beads.list_args`: default `list --json`
- `beads.closed_statuses`: default `["closed"]`
- `beads.active_statuses`: default `["open", "in_progress"]`
- `beads.claim_on_dispatch`: boolean, default `true`
- `polling.interval_ms`: integer, default `30000`
- `workspace.root`: path, default `<system-temp>/symphony_workspaces`
- `hooks.after_create`: shell script or null
- `hooks.before_run`: shell script or null
- `hooks.after_run`: shell script or null
- `hooks.before_remove`: shell script or null
- `hooks.timeout_ms`: integer, default `60000`
- `agent.max_concurrent_agents`: integer, default `10`
- `agent.max_turns`: integer, default `20`
- `agent.max_retry_backoff_ms`: integer, default `300000`
- `agent.max_concurrent_agents_by_status`: map of positive integers, default `{}`
- `codex.command`: shell command string, default `codex app-server`
- `codex.approval_policy`: pass-through
- `codex.thread_sandbox`: pass-through
- `codex.turn_sandbox_policy`: pass-through
- `codex.turn_timeout_ms`: integer, default `3600000`
- `codex.read_timeout_ms`: integer, default `5000`
- `codex.stall_timeout_ms`: integer, default `300000`

---

## 8. Orchestration State Machine

### 8.1 Bead Orchestration States

Internal service states:

1. `Unclaimed`
2. `Claimed`
3. `Running`
4. `RetryQueued`
5. `Released`

Important nuance:

- A successful worker exit does not mean the bead is permanently done.
- After each normal turn completion, the worker re-checks bead state.
- If the bead is still active, the worker should start another turn on the same live coding-agent thread in the same workspace, up to `agent.max_turns`.
- Once the worker exits normally, the orchestrator still schedules a short continuation retry so it can re-check whether the bead remains active.

### 8.2 Run Attempt Lifecycle

Phases:

1. `PreparingWorkspace`
2. `BuildingPrompt`
3. `LaunchingAgentProcess`
4. `InitializingSession`
5. `StreamingTurn`
6. `Finishing`
7. `Succeeded`
8. `Failed`
9. `TimedOut`
10. `Stalled`
11. `CanceledByReconciliation`

### 8.3 Transition Triggers

- `Poll Tick`
- `Worker Exit (normal)`
- `Worker Exit (abnormal)`
- `Codex Update Event`
- `Retry Timer Fired`
- `Reconciliation Refresh`
- `Stall Timeout`

### 8.4 Idempotency and Recovery Rules

- The orchestrator serializes state mutations through one authority.
- `claimed` and `running` checks are required before launching any worker.
- Reconciliation runs before dispatch on every tick.
- Restart recovery is bead-driven and filesystem-driven; no durable orchestrator DB is required.

---

## 9. Polling, Scheduling, and Reconciliation

### 9.1 Poll Loop

At startup, the service validates config, performs startup cleanup, schedules an immediate tick, and then repeats every `polling.interval_ms`.

Tick sequence:

1. Reconcile running beads.
2. Run dispatch preflight validation.
3. Fetch ready beads from `bd`.
4. Sort beads by dispatch priority.
5. Dispatch eligible beads while slots remain.
6. Notify observability consumers.

### 9.2 Candidate Selection Rules

A bead is dispatch-eligible only if all are true:

- It has `identifier`, `title`, and `status`.
- Its status is in active statuses and not in terminal statuses.
- It is returned as ready by the bead client or otherwise confirmed ready.
- It is not already in `running`.
- It is not already in `claimed`.
- Global concurrency slots are available.
- Per-status concurrency slots are available.

Sorting order:

1. `priority` ascending
2. `created_at` oldest first
3. `identifier` lexicographic tie-breaker

### 9.3 Concurrency Control

Global limit:

- `available_slots = max(max_concurrent_agents - running_count, 0)`

Per-status limit:

- `max_concurrent_agents_by_status[status]` if present
- otherwise fallback to global limit

### 9.4 Retry and Backoff

Retry entry creation:

- Cancel any existing retry timer for the same bead.
- Store `attempt`, `identifier`, `error`, `due_at_ms`, and new timer handle.

Backoff formula:

- Clean worker exits use short continuation retry of `1000` ms.
- Failure-driven retries use:
  - `delay = min(10000 * 2^(attempt - 1), agent.max_retry_backoff_ms)`

Retry handling behavior:

1. Re-fetch ready or active bead candidates as needed.
2. Find the specific bead by ID or identifier.
3. If not found or no longer active, release claim.
4. If found and eligible:
   - dispatch if slots are available
   - otherwise requeue with explicit error
5. If terminal, release claim and optionally clean workspace

### 9.5 Active Run Reconciliation

Reconciliation runs every tick and has two parts.

Part A: Stall detection

- For each running bead, compute elapsed time since last event or start time.
- If elapsed exceeds `codex.stall_timeout_ms`, terminate worker and queue a retry.
- If `stall_timeout_ms <= 0`, skip stall detection.

Part B: Bead state refresh

- Fetch current bead states for running bead IDs or identifiers.
- For each running bead:
  - if status is terminal: terminate worker and optionally clean workspace
  - if status is still active: update in-memory snapshot
  - if status is neither active nor terminal: terminate worker without cleanup
- If refresh fails, keep workers running and try again next tick.

### 9.6 Startup Terminal Workspace Cleanup

When the service starts:

1. Query `bd` for closed beads if feasible.
2. For each closed bead identifier, remove the corresponding workspace directory when cleanup policy allows.
3. If closed-bead fetch fails, log warning and continue startup.

---

## 10. Workspace Management and Safety

### 10.1 Workspace Layout

Workspace root:

- `workspace.root`

Per-bead workspace path:

- `<workspace.root>/<sanitized_bead_identifier>`

Workspace persistence:

- Workspaces are reused across runs for the same bead.
- Successful runs do not auto-delete workspaces.

### 10.2 Workspace Creation and Reuse

Algorithm summary:

1. Sanitize bead identifier.
2. Compute workspace path.
3. Ensure the workspace path exists as a directory.
4. Mark `created_now` only if directory was created during this call.
5. If `created_now=true`, run `after_create`.

### 10.3 Optional Workspace Population

The spec does not require built-in Git/bootstrap behavior. Implementations may populate or synchronize workspaces via hooks.

### 10.4 Workspace Hooks

Supported hooks:

- `hooks.after_create`
- `hooks.before_run`
- `hooks.after_run`
- `hooks.before_remove`

Execution contract:

- Execute in local shell context with workspace directory as `cwd`.
- On POSIX systems, `sh -lc` or `bash -lc` is conformant.
- Hook timeout uses `hooks.timeout_ms`.

Failure semantics:

- `after_create` failure is fatal to workspace creation.
- `before_run` failure is fatal to the current attempt.
- `after_run` failure is logged and ignored.
- `before_remove` failure is logged and ignored.

### 10.5 Safety Invariants

Invariant 1: Run the coding agent only in the per-bead workspace path.  
Invariant 2: Workspace path must stay inside workspace root.  
Invariant 3: Workspace key is sanitized.

---

## 11. Agent Runner Protocol

This section inherits Symphony’s coding-agent app-server integration model, with bead context substituted for tracker issue context.

### 11.1 Launch Contract

Subprocess launch parameters:

- Command: `codex.command`
- Invocation: `bash -lc <codex.command>`
- Working directory: bead workspace path
- Stdout/stderr: separate streams
- Framing: line-delimited JSON messages on stdout

### 11.2 Session Startup Handshake

The client sends these protocol messages in order:

1. `initialize`
2. `initialized`
3. `thread/start`
4. `turn/start`

`turn/start` should use:

- `cwd` = bead workspace path
- `title` = `<bead.identifier>: <bead.title>`
- `input` = rendered prompt for first turn, or continuation guidance for later turns

### 11.3 Streaming Turn Processing

Completion conditions:

- `turn/completed`
- `turn/failed`
- `turn/cancelled`
- `turn_timeout_ms`
- subprocess exit

Continuation processing:

- If the worker continues, it should issue another `turn/start` on the same thread.

### 11.4 Emitted Runtime Events

Events may include:

- `session_started`
- `startup_failed`
- `turn_completed`
- `turn_failed`
- `turn_cancelled`
- `turn_ended_with_error`
- `turn_input_required`
- `approval_auto_approved`
- `unsupported_tool_call`
- `notification`
- `other_message`
- `malformed`

### 11.5 Approval, Tool Calls, and User Input Policy

Approval, sandbox, and user-input behavior is implementation-defined.

Recommended bead-aware runtime behavior:

- Expose `bd` CLI in the workspace/runtime environment so agents can:
  - claim beads
  - move beads to `in_progress`
  - create new beads
  - add dependencies
  - close beads
- Unsupported dynamic tool calls should fail without stalling.
- User-input-required turns should not stall indefinitely.

### 11.6 Timeouts and Error Mapping

Recommended normalized categories:

- `codex_not_found`
- `invalid_workspace_cwd`
- `response_timeout`
- `turn_timeout`
- `process_exit`
- `response_error`
- `turn_failed`
- `turn_cancelled`
- `turn_input_required`

### 11.7 Agent Runner Contract

Behavior:

1. Create or reuse workspace for bead.
2. Build prompt from workflow template.
3. Start app-server session.
4. Forward events to orchestrator.
5. On any error, fail the worker attempt.

---

## 12. Bead Client Integration Contract

### 12.1 Required Operations

An implementation must support these bead adapter operations:

1. `fetch_ready_beads()`
   - Returns beads currently ready to work.

2. `fetch_beads_by_status(statuses)`
   - Used for startup cleanup and optional reconciliation.

3. `fetch_bead_states_by_ids_or_identifiers(refs)`
   - Used for active-run reconciliation.

### 12.2 Preferred Interface

Preferred interface is CLI-based via `bd --json`, though direct SQLite or library integration is allowed.

Recommended commands:

- `bd ready --json`
- `bd show <identifier> --json`
- `bd list --status <status> --json`

The adapter must normalize payloads into the domain model in Section 4.

### 12.3 Normalization Rules

- `priority` -> integer or null
- `labels` -> lowercase if present
- dependency references -> normalize to consistent shape
- `created_at` and `updated_at` -> parse timestamps if present

### 12.4 Error Handling Contract

Recommended error categories:

- `bd_not_found`
- `bd_command_failed`
- `bd_invalid_json`
- `bd_missing_identifier`
- `bd_unknown_payload`

Orchestrator behavior on errors:

- Ready fetch failure: log and skip dispatch for this tick.
- State refresh failure: log and keep active workers running.
- Startup cleanup failure: log warning and continue startup.

### 12.5 Bead Writes Boundary

Symphony does not require first-class bead write APIs in the orchestrator.

- Bead mutations are typically handled by the coding agent using `bd`.
- Workflow-specific success often means reaching a handoff state, not necessarily `closed`.
- Agents may create discovered work as new beads and link them into the dependency graph.

---

## 13. Prompt Construction and Context Assembly

### 13.1 Inputs

- `workflow.prompt_template`
- normalized `bead`
- optional `attempt`

### 13.2 Rendering Rules

- Strict variable checking
- Strict filter checking
- Preserve nested arrays/maps for iteration

### 13.3 Retry/Continuation Semantics

`attempt` should be passed because prompt behavior may differ for:

- first run
- continuation after clean prior session
- retry after error, timeout, or stall

### 13.4 Failure Semantics

If prompt rendering fails:

- Fail the run attempt immediately.
- Let the orchestrator treat it like any other worker failure.

---

## 14. Logging, Status, and Observability

### 14.1 Logging Conventions

Required context fields for bead-related logs:

- `bead_id`
- `bead_identifier`

Required context for coding-agent lifecycle logs:

- `session_id`

### 14.2 Logging Outputs and Sinks

The spec does not prescribe exact sinks.

Requirements:

- Operators must be able to see startup, validation, and dispatch failures.
- Sink failures should not crash the service.

### 14.3 Runtime Snapshot / Monitoring Interface

If exposed, it should return:

- `running`
- `retrying`
- `codex_totals`
- `rate_limits`
- optionally `ready_bead_count`
- optionally `total_known_beads`

### 14.4 Optional Human-Readable Status Surface

Optional and implementation-defined.

### 14.5 Session Metrics and Token Accounting

Same accounting principles as Symphony:

- Prefer absolute totals when available.
- Track deltas relative to last reported totals.
- Aggregate runtime seconds across ended and active sessions.

### 14.6 Humanized Agent Event Summaries

Optional and observability-only.

### 14.7 Optional HTTP Server Extension

If implemented, provide:

- `GET /api/v1/state`
- `GET /api/v1/<bead_identifier>`
- `POST /api/v1/refresh`

Suggested response fields should use bead terminology rather than issue terminology.

---

## 15. Failure Model and Recovery Strategy

### 15.1 Failure Classes

1. Workflow/config failures
2. Workspace failures
3. Agent session failures
4. Bead client failures
5. Observability failures

### 15.2 Recovery Behavior

- Dispatch validation failures:
  - skip new dispatches
  - keep service alive
  - continue reconciliation
- Worker failures:
  - convert to retries with exponential backoff
- Bead fetch failures:
  - skip this tick
  - retry on next tick
- Reconciliation refresh failures:
  - keep workers running
- Dashboard/log failures:
  - do not crash orchestrator

### 15.3 Partial State Recovery (Restart)

After restart:

- No retry timers are restored.
- No running sessions are assumed recoverable.
- Service recovers by:
  - startup workspace cleanup
  - fresh polling of ready beads
  - re-dispatching eligible work

### 15.4 Operator Intervention Points

Operators can control behavior by:

- editing `WORKFLOW.md`
- changing bead status or dependencies in `bd`
- restarting the service for deployment or process recovery

---

## 16. Security and Operational Safety

### 16.1 Trust Boundary Assumption

Each implementation defines its trust boundary.

Operational safety requirements:

- State whether environment is trusted, restricted, or mixed.
- State whether actions are auto-approved, operator-approved, sandboxed, or some combination.

### 16.2 Filesystem Safety Requirements

Mandatory:

- workspace path remains under configured workspace root
- coding-agent cwd is the per-bead workspace path
- workspace directory names use sanitized identifiers

### 16.3 Secret Handling

- Support `$VAR` indirection
- Do not log secrets
- Validate presence of secrets without printing them

### 16.4 Hook Script Safety

Hooks are trusted configuration and run inside the workspace.

### 16.5 Harness Hardening Guidance

Implementations should evaluate:

- approval policy strictness
- sandboxing
- network restrictions
- credential scoping
- which `bd` operations are available to the agent
- whether bead creation and mutation should be constrained by repo/workflow policy

---

## 17. Reference Algorithms

### 17.1 Service Startup

```text
function start_service():
  configure_logging()
  start_observability_outputs()
  start_workflow_watch(on_change=reload_and_reapply_workflow)

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    max_concurrent_agents: get_config_max_concurrent_agents(),
    running: {},
    claimed: set(),
    retry_attempts: {},
    completed: set(),
    codex_totals: {input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0},
    codex_rate_limits: null
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_terminal_workspace_cleanup()
  schedule_tick(delay_ms=0)

  event_loop(state)
```

### 17.2 Poll-and-Dispatch Tick

```text
on_tick(state):
  state = reconcile_running_beads(state)

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  beads = bead_client.fetch_ready_beads()
  if beads failed:
    log_bead_client_error()
    notify_observers()
    schedule_tick(state.poll_interval_ms)
    return state

  for bead in sort_for_dispatch(beads):
    if no_available_slots(state):
      break

    if should_dispatch(bead, state):
      state = dispatch_bead(bead, state, attempt=null)

  notify_observers()
  schedule_tick(state.poll_interval_ms)
  return state
```

### 17.3 Reconcile Active Runs

```text
function reconcile_running_beads(state):
  state = reconcile_stalled_runs(state)

  running_refs = keys(state.running)
  if running_refs is empty:
    return state

  refreshed = bead_client.fetch_bead_states_by_ids_or_identifiers(running_refs)
  if refreshed failed:
    log_debug("keep workers running")
    return state

  for bead in refreshed:
    if bead.status in terminal_statuses:
      state = terminate_running_bead(state, bead.id, cleanup_workspace=true)
    else if bead.status in active_statuses:
      state.running[bead.id].bead = bead
    else:
      state = terminate_running_bead(state, bead.id, cleanup_workspace=false)

  return state
```

### 17.4 Dispatch One Bead

```text
function dispatch_bead(bead, state, attempt):
  worker = spawn_worker(
    fn -> run_agent_attempt(bead, attempt, parent_orchestrator_pid) end
  )

  if worker spawn failed:
    return schedule_retry(state, bead.id, next_attempt(attempt), {
      identifier: bead.identifier,
      error: "failed to spawn agent"
    })

  state.running[bead.id] = {
    worker_handle,
    monitor_handle,
    identifier: bead.identifier,
    bead,
    session_id: null,
    codex_app_server_pid: null,
    last_codex_message: null,
    last_codex_event: null,
    last_codex_timestamp: null,
    codex_input_tokens: 0,
    codex_output_tokens: 0,
    codex_total_tokens: 0,
    last_reported_input_tokens: 0,
    last_reported_output_tokens: 0,
    last_reported_total_tokens: 0,
    retry_attempt: normalize_attempt(attempt),
    started_at: now_utc()
  }

  state.claimed.add(bead.id)
  state.retry_attempts.remove(bead.id)
  return state
```

### 17.5 Worker Attempt

```text
function run_agent_attempt(bead, attempt, orchestrator_channel):
  workspace = workspace_manager.create_for_bead(bead.identifier)
  if workspace failed:
    fail_worker("workspace error")

  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = app_server.start_session(workspace=workspace.path)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, bead, attempt, turn_number, max_turns)
    if prompt failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = app_server.run_turn(
      session=session,
      prompt=prompt,
      bead=bead,
      on_message=(msg) -> send(orchestrator_channel, {codex_update, bead.id, msg})
    )

    if turn_result failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_bead = bead_client.fetch_bead_states_by_ids_or_identifiers([bead.id or bead.identifier])
    if refreshed_bead failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("bead state refresh error")

    bead = refreshed_bead[0] or bead

    if bead.status is not active:
      break

    if turn_number >= max_turns:
      break

    turn_number = turn_number + 1

  app_server.stop_session(session)
  run_hook_best_effort("after_run", workspace.path)

  exit_normal()
```

### 17.6 Worker Exit and Retry Handling

```text
on_worker_exit(bead_id, reason, state):
  running_entry = state.running.remove(bead_id)
  state = add_runtime_seconds_to_totals(state, running_entry)

  if reason == normal:
    state.completed.add(bead_id)
    state = schedule_retry(state, bead_id, 1, {
      identifier: running_entry.identifier,
      delay_type: continuation
    })
  else:
    state = schedule_retry(state, bead_id, next_attempt_from(running_entry), {
      identifier: running_entry.identifier,
      error: format("worker exited: %reason")
    })

  notify_observers()
  return state
```

```text
on_retry_timer(bead_id, state):
  retry_entry = state.retry_attempts.pop(bead_id)
  if missing:
    return state

  beads = bead_client.fetch_ready_beads()
  if fetch failed:
    return schedule_retry(state, bead_id, retry_entry.attempt + 1, {
      identifier: retry_entry.identifier,
      error: "retry poll failed"
    })

  bead = find_by_id(beads, bead_id)
  if bead is null:
    state.claimed.remove(bead_id)
    return state

  if available_slots(state) == 0:
    return schedule_retry(state, bead_id, retry_entry.attempt + 1, {
      identifier: bead.identifier,
      error: "no available orchestrator slots"
    })

  return dispatch_bead(bead, state, attempt=retry_entry.attempt)
```

---

## 18. Test and Validation Matrix

A conforming implementation should include tests for:

### 18.1 Workflow and Config Parsing

- workflow path precedence
- dynamic reload
- invalid reload keeps last known good config
- missing `WORKFLOW.md` error
- invalid YAML error
- front matter non-map error
- config defaults
- `beads.command` validation
- `$VAR` resolution
- `~` path expansion
- strict prompt rendering

### 18.2 Workspace Manager and Safety

- deterministic workspace path per bead
- directory creation and reuse
- hook execution semantics
- path sanitization
- root containment
- agent cwd correctness

### 18.3 Bead Client

- ready bead fetch
- bead detail fetch
- closed bead fetch for cleanup
- normalization correctness
- error mapping for command failures and invalid JSON

### 18.4 Orchestrator Dispatch, Reconciliation, and Retry

- dispatch sort order
- ready bead eligibility
- active status refresh updates running entry
- non-active status stops running agent
- terminal status stops running agent and optionally cleans workspace
- normal worker exit schedules short continuation retry
- abnormal worker exit schedules exponential backoff retry
- retry backoff cap uses configured max
- stall detection schedules retry
- slot exhaustion requeues with explicit reason

### 18.5 Coding-Agent App-Server Client

- launch command uses workspace cwd
- startup handshake order
- timeout enforcement
- stdout/stderr separation
- unsupported tool calls do not stall
- user-input-required behavior follows documented policy
- usage/rate-limit extraction works

### 18.6 Observability

- validation failures are operator-visible
- structured logging includes bead and session context
- logging sink failures do not crash orchestration
- token/rate-limit aggregation remains correct

### 18.7 CLI and Host Lifecycle

- CLI accepts optional workflow path
- CLI defaults to `./WORKFLOW.md`
- startup failures surface cleanly
- startup and shutdown exit codes are correct

---

## 19. Final Architectural Principle

The system is split cleanly into two authorities:

- **`bd` is the graph brain**
  - It owns bead identity, dependency structure, readiness, and work-state semantics.

- **Symphony is the execution engine**
  - It owns polling, claiming, runtime coordination, retries, workspaces, and agent sessions.

Normative principle:

> Work is not a flat task list. Work is a graph of beads.  
> Symphony continuously pulls ready beads from that graph, executes them in isolated workspaces, and feeds the evolving graph back into the next scheduling cycle.
