# paperclip-chat · Implementation Spec

> Master execution plan for coding agents. Every task has WHAT / WHY / VERIFY.
> Source of truth: `paperclip-chat-handoff-v6.docx`
> Companion docs: `PAPERCLIP_DESIGN_SYSTEM.md`, `PAPERCLIP_CODING_GUIDELINES.md`

---

## How this doc works

- **6 Phases**, each split into **Sprints** (2–3 day blocks)
- Every task has three fields:
  - **WHAT**: Exactly what to build / produce
  - **WHY**: The reason it exists (traced to handoff section)
  - **VERIFY**: How a reviewer or CI confirms it's done correctly
- Each Sprint ends with a **Sprint Gate** — a checklist that must pass before moving on
- Each Phase ends with a **Phase Gate** — an integration-level acceptance test
- Tasks marked `[BLOCKING]` must complete before any subsequent task in the sprint starts
- Tasks marked `[PARALLEL]` can be built simultaneously

---

# PHASE 1 — Foundation (Week 1)

> Scaffold the project, establish auth, connect to Paperclip, get WebSocket hub running.
> After this phase: the app boots, authenticates all three principals, seeds channels from Paperclip, and has a WS connection that echoes events.

---

## Sprint 1.1 — Project scaffold + database (Days 1–2)

### Task 1.1.1 — Initialize monorepo [BLOCKING]

**WHAT**: Create the `paperclip-chat/` monorepo with pnpm workspaces:
```
paperclip-chat/
├── server/           # Express + WS server
│   ├── src/
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── ui/               # React + Vite
│   ├── src/
│   ├── components.json    # Copy from Paperclip ui/components.json
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── vitest.config.ts
├── packages/shared/  # Types, constants, validators, API prefixes
│   ├── src/
│   └── package.json
├── pnpm-workspace.yaml
├── package.json      # Root scripts: dev, build, typecheck, test:run
└── tsconfig.base.json
```

**WHY**: Mirror Paperclip's monorepo structure (see CODING_GUIDELINES §2) so contributors move between repos without friction. (Handoff §16)

**VERIFY**:
```bash
pnpm install                    # installs without errors
pnpm typecheck                  # passes across all packages
pnpm build                      # builds server + ui
cat pnpm-workspace.yaml         # lists server, ui, packages/*
cat ui/components.json           # matches Paperclip's shadcn config
```

---

### Task 1.1.2 — Database schema + migrations [BLOCKING]

**WHAT**: Create Drizzle ORM schema for all 7 tables from handoff §7.1:

| Table | Key columns | Notes |
|-------|-------------|-------|
| `channels` | id (uuid PK), type (enum), company_id, paperclip_ref_id, name | type: company_general, project, dm, task_thread |
| `channel_participants` | id, channel_id (FK), participant_type (human/agent), participant_id, joined_at | Join table — handoff didn't have this, but v5 review flagged it |
| `chat_sessions` | id (uuid PK), channel_id (FK), status (active/closed), chunk_window_W_tokens (int, default 1200), verbatim_K_tokens (int, default 800), current_seq (int, default 0) | Session header |
| `turns` | id (uuid PK), session_id (FK), seq (serial), from_participant_id, content (text), token_count (int), summarize (bool, default true), mentioned_ids (text[]), is_decision (bool, default false), created_at | Append-only trunk. token_count set at write via js-tiktoken |
| `trunk_chunks` | id (uuid PK), session_id (FK), chunk_start (int), chunk_end (int), summary (text), summary_token_count (int), input_token_count (int), dirty (bool, default false) | Pre-computed chunk summaries |
| `session_summaries` | session_id (uuid PK), text, token_count (int), chunk_seq_covered (int), updated_at | Rolling global summary. One row per session. |
| `agent_channel_states` | id (uuid PK), session_id (FK), participant_id, status (absent/observing/active), anchor_seq (int), cli_session_id (text nullable), cli_session_path (text nullable), idle_turn_count (int, default 0), tokens_this_session (int, default 0) | UNIQUE(session_id, participant_id) |
| `notifications` | id (uuid PK), user_id, company_id, type (agent_initiated/unread_message/decision_pending), payload (jsonb), read_at (timestamp nullable), created_at | Persistent notification queue |

Create indexes:
- `turns(session_id, seq)`
- `trunk_chunks(session_id, chunk_start, chunk_end)`
- `agent_channel_states(session_id, participant_id)` UNIQUE
- `notifications(user_id, read_at)` partial index WHERE read_at IS NULL

**WHY**: Data model is the foundation everything builds on. Token-aware fields (token_count, chunk_window_W_tokens, verbatim_K_tokens) are critical — the entire context strategy depends on them. (Handoff §7.1)

**VERIFY**:
```bash
pnpm db:generate                # generates migration SQL file
pnpm db:migrate                 # applies cleanly to fresh Postgres
# Inspect: all 8 tables exist with correct columns, types, indexes
psql $DATABASE_URL -c "\dt"     # lists all tables
psql $DATABASE_URL -c "\di"     # lists all indexes
pnpm typecheck                  # Drizzle types compile
```

---

### Task 1.1.3 — Shared types, constants, and validators

**WHAT**: Create in `packages/shared/src/`:

`types/chat.ts` — TypeScript interfaces for all entities (Turn, ChatSession, Channel, AgentChannelState, TrunkChunk, SessionSummary, Notification, ChannelParticipant)

`constants.ts` — All defaults from handoff §9.6:
```typescript
export const CHAT_DEFAULTS = {
  T_WINDOW: 1200,
  K_TOKENS: 800,
  PACKET_BUDGET: 3000,
  SUMMARY_BUDGET_DM: 500,
  SUMMARY_BUDGET_GROUP: 600,
  COALESCE_MS: 800,
  K_ACTIVE_THRESHOLD: 5,
  W_DM: 10,
  CHAT_TOKEN_EXPIRY: '10m',
} as const

export const CHANNEL_TYPES = ['company_general', 'project', 'dm', 'task_thread'] as const
export const AGENT_CHANNEL_STATUSES = ['absent', 'observing', 'active'] as const
export const CHAT_PRESENCE = ['available', 'busy_task', 'busy_dm', 'offline'] as const
export const SESSION_STATUSES = ['active', 'closed'] as const
export const NOTIFICATION_TYPES = ['agent_initiated', 'unread_message', 'decision_pending'] as const
```

`api.ts` — All API endpoint paths (see CODING_GUIDELINES §4.3)

`validators/chat.ts` — Zod schemas: sendMessageSchema, openSessionSchema, closeSessionSchema, createChannelSchema

**WHY**: Shared package ensures server and UI stay in sync on types. Zod validators enforce contracts at every boundary. Constants centralize tunables. (Handoff §9.6, CODING_GUIDELINES §4)

**VERIFY**:
```bash
pnpm typecheck                  # types compile across packages
# Unit test: each Zod schema rejects invalid input, accepts valid input
pnpm test:run -- --filter shared
```

---

### Sprint 1.1 Gate

```
✅ pnpm install → clean
✅ pnpm typecheck → 0 errors across all packages
✅ pnpm db:migrate → all 8 tables created with correct indexes
✅ pnpm test:run → shared package Zod validator tests pass
✅ packages/shared exports all types, constants, validators, API paths
```

---

## Sprint 1.2 — Auth + Paperclip adapter (Days 3–4)

### Task 1.2.1 — Service account registration [BLOCKING]

**WHAT**: Create `server/src/auth/serviceAccount.ts`:
- On startup, call Paperclip `POST /api/agents` (or upsert equivalent) to register `paperclip-chat-server` as an agent with `adapterType: 'http'`, `role: 'general'`
- Idempotent — safe to call on every restart
- Store/read `CHAT_SERVICE_KEY` from env
- Validate key on startup by calling `GET /api/agents` — fail fast if invalid
- Health check every 60s (handoff §8.4 error handling)

**WHY**: chat-server needs a long-lived identity for all Paperclip API calls that happen outside any user/agent context (background chunker, fold, crystallize, workspace resolution). (Handoff §4.2, §4.3)

**VERIFY**:
```bash
# Start chat-server with valid CHAT_SERVICE_KEY + PAPERCLIP_API_URL
# Observe: startup log shows "Service account validated: paperclip-chat-server"
# Start with invalid key → startup fails with clear error message
# Start with missing key → startup fails with "CHAT_SERVICE_KEY required" error
```

---

### Task 1.2.2 — Paperclip REST client [BLOCKING]

**WHAT**: Create `server/src/adapters/paperclipClient.ts`:

Typed client with methods for every Paperclip API call from handoff §3.2:
- `getAgent(agentId)` → Agent config (adapterType, workspaceDir, bootstrapPrompt)
- `getCompany(companyId)` → Company context
- `createIssue(companyId, issue)` → Scaffold issue for wakeup + crystallize
- `checkoutIssue(issueId, agentId)` → Checkout for wakeup path
- `postComment(issueId, comment)` → Deliver message for wakeup path
- `wakeupAgent(agentId, wakeup)` → Trigger heartbeat
- `postCost(costEvent)` → Record background LLM costs
- `validateSession(cookie)` → Validate human auth
- `getProjectWorkspace(projectId)` → Workspace resolution
- `getIssue(issueId)` → Issue details for task_thread workspace

Every call:
- Uses `CHAT_SERVICE_KEY` in Authorization header
- Includes `X-Paperclip-Run-Id: chat-server-{uuid}` for audit trail
- Zod-validates responses
- Retries 5xx: 1s, 2s, 4s (3 attempts) per handoff §8.4
- Logs errors without exposing the service key

**WHY**: Single typed client for all Paperclip API interactions. Retry logic prevents transient failures from cascading. Zod validation catches API contract drift early. (Handoff §3.2, §8.4)

**VERIFY**:
```bash
# Integration test against running Paperclip instance:
pnpm test:run -- --filter server --grep "PaperclipClient"
# Tests: getAgent returns valid agent, createIssue returns issue ID,
#        5xx triggers retry (mock server), invalid response throws ZodError,
#        missing X-Paperclip-Run-Id header is always present (inspect logs)
```

---

### Task 1.2.3 — Human auth middleware [PARALLEL]

**WHAT**: Create `server/src/auth/validateHuman.ts`:
- Extract `paperclip-session` cookie from request
- Call `paperclipClient.validateSession(cookie)` to verify
- On success: set `req.userId`, `req.companyId` on request object
- On failure: return 401 JSON `{ error: 'Not authenticated' }`

**WHY**: Humans authenticate via Paperclip's existing better-auth session. No new auth infrastructure needed. (Handoff §4.1)

**VERIFY**:
```bash
# Test with valid Paperclip session cookie → 200 + req.userId set
# Test with expired/invalid cookie → 401 JSON error
# Test with no cookie → 401 JSON error
# Test cookie is NOT logged in any error output
```

---

### Task 1.2.4 — Agent auth middleware [PARALLEL]

**WHAT**: Create `server/src/auth/validateAgent.ts` and `server/src/auth/chatTokens.ts`:

`chatTokens.ts`:
- `signChatToken({ agentId, sessionId, exp })` → JWT signed with `CHAT_TOKEN_SECRET`
- `verifyChatToken(token)` → claims or null

`validateAgent.ts`:
- Extract Bearer token from Authorization header
- Try `verifyChatToken()` first (CHAT_API_TOKEN path for subprocess_cli agents)
- Fall back to `paperclipClient.validateAgentJwt()` (PAPERCLIP_API_KEY path for mid-heartbeat agents)
- On success: set `req.agentId`, `req.companyId`, optionally `req.sessionId`
- On failure: return 401

**WHY**: Two agent auth paths: subprocess_cli agents use chat-server-issued JWT (CHAT_API_TOKEN, 10 min), mid-heartbeat agents use Paperclip's run-scoped JWT. Both must work. (Handoff §4.1, §4.3, §4.4)

**VERIFY**:
```bash
# Test: valid CHAT_API_TOKEN → 200, req.agentId set
# Test: expired CHAT_API_TOKEN → falls through to Paperclip JWT check
# Test: valid PAPERCLIP_API_KEY → 200, req.agentId set
# Test: both invalid → 401
# Test: CHAT_API_TOKEN with wrong secret → rejected (not forwarded to Paperclip)
# Test: signChatToken generates JWT with correct claims and expiry
```

---

### Task 1.2.5 — Combined auth middleware

**WHAT**: Create `server/src/auth/authenticate.ts`:
- Single middleware that accepts ANY valid principal (human, agent subprocess, agent mid-heartbeat, service)
- Tries human cookie first, then agent Bearer token
- Sets `req.principal` with `{ type: 'human' | 'agent' | 'service', id, companyId }`
- Route-level auth decorators: `requireHuman`, `requireAny`, `requireService`

**WHY**: REST endpoints in handoff §13.1 show different auth requirements per endpoint. Need composable middleware. (Handoff §13.1 auth column)

**VERIFY**:
```bash
# Test each principal type authenticates correctly
# Test: public endpoint (SKILL.md) needs no auth
# Test: /api/notifications requires human auth (agent tokens rejected)
# Test: /api/sessions/:id/send accepts any authenticated principal
```

---

### Sprint 1.2 Gate

```
✅ chat-server boots and registers service account with Paperclip
✅ CHAT_SERVICE_KEY validation on startup — fails fast if invalid
✅ PaperclipClient methods work against running Paperclip (integration test)
✅ Human cookie auth works end-to-end
✅ CHAT_API_TOKEN sign/verify round-trips
✅ Agent auth accepts both token types
✅ Auth middleware rejects all invalid tokens with 401
✅ pnpm typecheck passes
```

---

## Sprint 1.3 — Channels, WS hub, Paperclip WS subscription (Days 5–6)

### Task 1.3.1 — Channel seeding from Paperclip

**WHAT**: On startup (after service account validates):
- Fetch all companies via `paperclipClient.getCompany()`
- For each company: auto-create `company_general` channel if not exists
- Fetch all projects: auto-create `project` channels for each
- Store `paperclip_ref_id` linking channel to Paperclip entity
- API: `GET /api/channels` (list, filtered by company_id), `POST /api/channels` (create)

**WHY**: Channels should exist before any user opens chat. company_general is auto-created per company. project channels map to Paperclip projects. (Handoff §12)

**VERIFY**:
```bash
# Boot chat-server against Paperclip with 1 company and 2 projects
# Verify: 3 channels created (1 company_general + 2 project)
# GET /api/channels?companyId=X → returns all 3
# POST /api/channels with type=dm → creates DM channel
# Duplicate company_general creation → idempotent (no error, no duplicate)
```

---

### Task 1.3.2 — WebSocket hub [BLOCKING]

**WHAT**: Create `server/src/ws/hub.ts`:
- Raw `ws` library WebSocket server (NOT Socket.IO)
- Authenticate on upgrade (cookie or Bearer token in query param)
- Per-channel subscription: clients send `{ type: 'subscribe', channelId }` to join
- Broadcast: `hub.broadcast(channelId, event)` sends to all subscribers of that channel
- Global broadcast: `hub.broadcastToUser(userId, event)` for notifications
- Ping/pong keepalive every 30s, disconnect dead connections
- Message envelope: `{ type: string, payload: unknown, timestamp: string }`
- Define all event types as constants (CHAT_EVENT_TYPES from CODING_GUIDELINES §3.5)

**WHY**: Real-time delivery of messages, streaming tokens, typing indicators, presence, notifications. Must be per-channel (not broadcast-all) for efficiency. (Handoff §13.2)

**VERIFY**:
```bash
# Test: WS connects with valid auth → accepted
# Test: WS connects without auth → rejected (4401 close code)
# Test: subscribe to channel → receives events for that channel only
# Test: broadcast to channel → all subscribers receive, non-subscribers don't
# Test: ping/pong → dead connection cleaned up after 2 missed pongs
# Test: message envelope format matches spec
```

---

### Task 1.3.3 — Paperclip WS subscription for agent.status

**WHAT**: Create `server/src/adapters/paperclipWs.ts`:
- On startup, connect to Paperclip's WS at `GET /api/companies/:id/events/ws` using `CHAT_SERVICE_KEY`
- Listen for `agent.status` events
- Feed into `PresenceStateMachine` (stub for now — just store status in a Map)
- Auto-reconnect with exponential backoff on disconnect
- Log connection state changes

**WHY**: chat-server must know when agents are busy (heartbeat running) to enforce the "queue behind heartbeat" rule. This is the detection mechanism from handoff §5.3. (Handoff §3.2, §5.3)

**VERIFY**:
```bash
# Boot chat-server → connects to Paperclip WS
# Trigger a heartbeat in Paperclip → chat-server logs agent.status = running
# Heartbeat completes → chat-server logs agent.status = idle
# Kill Paperclip WS → chat-server reconnects within 5s
# Verify: presence Map has correct state for each agent
```

---

### Task 1.3.4 — Express app assembly + health check

**WHAT**: Create `server/src/index.ts`:
- Initialize PaperclipClient
- Register service account
- Run DB migrations
- Mount auth middleware
- Mount route handlers (channels for now, sessions/notifications as stubs)
- Start WS hub on same HTTP server
- Connect to Paperclip WS
- `GET /api/health` → `{ status: 'ok', paperclip: 'connected', ws: 'running' }`
- Serve chat-ui static build from `ui/dist/` (same pattern as Paperclip server)

**WHY**: Single entry point that boots the entire system. Health check confirms all subsystems are running. (Handoff — implicit in architecture)

**VERIFY**:
```bash
# Boot: chat-server starts on configured port
# GET /api/health → { status: 'ok', paperclip: 'connected', ws: 'running' }
# GET /api/channels → returns seeded channels
# WS connection → accepted with valid auth
# Static UI served at /
```

---

### Sprint 1.3 Gate

```
✅ chat-server boots end-to-end: DB → service account → Paperclip WS → WS hub → Express
✅ /api/health returns all-green
✅ Channels seeded from Paperclip org structure
✅ WS hub accepts connections, per-channel subscribe/broadcast works
✅ Paperclip WS subscription receives agent.status events
✅ Auto-reconnect works on Paperclip WS disconnect
```

---

## ✅ PHASE 1 GATE — Integration acceptance test

```
BOOT TEST:
  1. Start Paperclip with 1 company, 2 agents (claude_local), 1 project
  2. Start chat-server with CHAT_SERVICE_KEY, PAPERCLIP_API_URL, DATABASE_URL
  3. Verify: service account registered in Paperclip agent list
  4. Verify: 3 channels auto-created (company_general + 1 project + 0 DMs)
  5. Verify: /api/health → all green

AUTH TEST:
  6. Open browser, login to Paperclip → session cookie set
  7. GET /api/channels with cookie → 200 + channel list
  8. GET /api/channels without cookie → 401
  9. Generate CHAT_API_TOKEN → use as Bearer → 200
  10. Use expired token → 401

WS TEST:
  11. Connect WS with valid cookie → accepted
  12. Subscribe to company_general channel
  13. Trigger agent heartbeat in Paperclip → agent.status event received by chat-server
  14. Chat-server presence Map shows agent as 'running' then 'idle'

ALL TESTS PASS → Proceed to Phase 2
```

---

# PHASE 2 — subprocess_cli Core (Week 2)

> The entire v1 product. After this phase: humans can @mention agents in chat, agents respond via CLI subprocess with streaming, sessions persist across turns, wakeup coalescing works, tokens are counted.

---

## Sprint 2.1 — Turn processing + token counting (Days 7–8)

### Task 2.1.1 — TrunkManager: turn insert with token counting [BLOCKING]

**WHAT**: Create `server/src/context/TrunkManager.ts`:
- `insertTurn(sessionId, fromParticipantId, content, mentionedIds)`:
  - Count tokens via `js-tiktoken` (cl100k_base) — install `js-tiktoken` package
  - Set `summarize = false` if content matches low-value patterns: exact matches for 'ok', 'k', '+1', 'thanks', 'ty', single emoji (regex: `/^\p{Emoji}$/u`), or content under 3 characters
  - Increment `chat_sessions.current_seq`
  - Insert turn with `seq`, `token_count`, `summarize`, `mentioned_ids`, `is_decision` (detect `[DECISION]` prefix)
  - Return the complete Turn object
- Token counter must be initialized once (module-level), not per-call

**WHY**: The trunk is the authoritative conversation history. Token counting at write time is the foundational invariant — all downstream (chunker, packet assembly, budget gating) is pure arithmetic. The "billion-token mistake" from Paperclip's codex integration happened because they used cumulative totals instead of per-turn deltas. (Handoff §7.1, §9.6 token pipeline, Key Invariant #6)

**VERIFY**:
```bash
# Unit test: insert turn → token_count is positive integer (~4 tokens per word)
# Unit test: 'ok' → summarize=false, 'Let me check the auth flow' → summarize=true
# Unit test: '[DECISION] Ship the v2 API' → is_decision=true
# Unit test: emoji '👍' → summarize=false
# Unit test: seq increments correctly across multiple inserts
# Benchmark: js-tiktoken tokenize 1000 chars < 1ms
```

---

### Task 2.1.2 — processTurn full flow (human messages) [BLOCKING]

**WHAT**: Create `server/src/session/SessionManager.ts` with `processTurn()`:

Implement the full flow from handoff §8.3:
1. Call `trunkManager.insertTurn()` — token count + append
2. Check if cumulative tokens since last chunk >= T_WINDOW → enqueue chunk job (stub for Phase 3)
3. Broadcast `chat.message` WS event to all channel subscribers
4. Insert notification for offline humans (check WS hub for connected users)
5. Parse @mentions from content (regex: `@[A-Za-z0-9_-]+` or participant lookup)
6. For @mentioned agents: enqueue in debounce buffer (Task 2.1.3)
7. Update `agent_channel_states.idle_turn_count` for all non-sender agent participants

**WHY**: This is the central function — every message flows through it. Must be correct on turn 1 because everything else builds on it. (Handoff §8.3)

**VERIFY**:
```bash
# Integration test: send message → turn appears in DB with correct token_count
# Integration test: send message → WS subscribers receive chat.message event
# Integration test: send message → idle_turn_count incremented for other agents
# Integration test: @mention agent → debounce buffer receives the mention
# Integration test: offline human → notification row created
# Test: [DECISION] prefix → session.decision WS event emitted
```

---

### Task 2.1.3 — Wakeup coalescing / debounce buffer

**WHAT**: Create `server/src/session/Debounce.ts`:

```typescript
class DebounceBuffer {
  // Per agent per session: buffer turns, reset timer on each new turn
  // On flush: call provided callback with batched turns
  // Timer resets on each enqueue (800ms after LAST message, not first)
  // TODO Phase 5: also reset on typing WS events
}
```

Config: `COALESCE_MS` from env or default 800ms.

On flush: call `flushToAgent(agentId, batchedTurns)` which will invoke subprocess spawn (Task 2.2.1) or wakeup (Phase 6).

**WHY**: Rapid messages (3 in 2 seconds) must become one agent wakeup, not three. WS delivery to humans is immediate — only agent invocation is debounced. (Handoff §8.2)

**VERIFY**:
```bash
# Unit test (fake timers): enqueue 3 turns in 200ms → flush called once with 3 turns
# Unit test: enqueue 1 turn, wait 500ms, enqueue another → timer resets, flush at 800ms after second
# Unit test: enqueue 1 turn, wait 900ms → flush at 800ms with 1 turn (first fires before second arrives)
# Unit test: different agentIds → independent buffers
```

---

### Sprint 2.1 Gate

```
✅ Turns insert with correct token counts via js-tiktoken
✅ Low-value turn detection (summarize=false) works
✅ [DECISION] detection works
✅ processTurn broadcasts WS event to subscribers
✅ processTurn creates notifications for offline humans
✅ Debounce buffer batches correctly with timer reset behavior
✅ idle_turn_count updated for non-sender agents
✅ pnpm test:run passes all new tests
```

---

## Sprint 2.2 — Subprocess spawn + session management (Days 9–11)

### Task 2.2.1 — PresenceStateMachine [BLOCKING]

**WHAT**: Create `server/src/subprocess/PresenceStateMachine.ts`:

Consumes agent.status events from Paperclip WS (Task 1.3.3). Maintains per-agent state:

| Paperclip agent.status | Chat presence | Spawn allowed? |
|------------------------|--------------|----------------|
| running | busy_task | NO — buffer turns, flush when idle |
| idle / available | available | YES — spawn immediately (subject to lock) |
| error / terminated | offline | NO — store turns, no delivery ETA |
| (chat subprocess active) | busy_dm | NO — spawn lock holds, other channels queue |

On transition to `available`: call `chatQueue.flush(agentId)` to trigger pending spawns.

**WHY**: Key Invariant #1 — never spawn while Paperclip heartbeat is running. This is the enforcement mechanism. (Handoff §5.3, §5.5)

**VERIFY**:
```bash
# Unit test: agent status = running → spawn request returns 'queued'
# Unit test: agent status transitions to idle → flush called with buffered turns
# Unit test: agent goes offline → turns stored, no flush
# Integration test: trigger heartbeat in Paperclip → chat-server blocks spawn → heartbeat completes → spawn executes
```

---

### Task 2.2.2 — WorkspaceResolver [BLOCKING]

**WHAT**: Create `server/src/subprocess/WorkspaceResolver.ts`:

Implement `resolveChatWorkspace(channel, agentId)` per handoff §6.1:

| Channel type | workspaceDir | Rationale |
|-------------|-------------|-----------|
| dm | `~/.paperclip/agents/{agentId}/workspace/` | No project context needed |
| company_general | `~/.paperclip/agents/{agentId}/workspace/` | Cross-project channel |
| project | Project primary workspace from Paperclip (fallback: agent home) | Agent needs source code |
| task_thread | Issue's project workspace from Paperclip (fallback: agent home) | Anchored to issue |

All chat CLI session files go to `~/.claude/chat-sessions/{sessionId}/` — NEVER Paperclip's `~/.claude/projects/` namespace. (Handoff §6.2, Key Invariant #2)

**WHY**: Physical workspace separation prevents chat and task CLI sessions from colliding. The workspaceDir determines what code the agent can see during conversation. Session file isolation is a safety invariant. (Handoff §6.1, §6.2)

**VERIFY**:
```bash
# Unit test: dm channel → returns agent home path
# Unit test: project channel with valid workspace → returns project path
# Unit test: project channel with no workspace → falls back to agent home
# Unit test: task_thread with project → returns project workspace
# Unit test: returned paths never contain '~/.claude/projects/' (Paperclip namespace)
```

---

### Task 2.2.3 — SubprocessManager with global spawn lock [BLOCKING]

**WHAT**: Create `server/src/subprocess/SubprocessManager.ts`:

Core responsibilities:
1. **Global per-agent spawn lock** (Promise-based queue, handoff §5.4):
   - `spawnLocks: Map<agentId, Promise<void>>`
   - Second spawn for same agent (any channel) waits for first to complete
2. **Check PresenceStateMachine** before spawning:
   - If `busy_task`: defer to queue (PresenceStateMachine flushes later)
   - If `available`: proceed with spawn
3. **Spawn CLI subprocess**:
   - Resolve workspace via WorkspaceResolver
   - Build args: `['--print', prompt, '--output-format', 'stream-json']`
   - If `cli_session_id` exists: add `['--resume', cli_session_id]`
   - Inject env: `CHAT_API_URL`, `CHAT_SESSION_ID`, `CHAT_API_TOKEN` (signed), `PAPERCLIP_WAKE_REASON=chat_message`, `PAPERCLIP_WAKE_COMMENT_ID=turn.id`
   - Set `cwd` from WorkspaceResolver
4. **Stream stdout** to WS as `chat.message.stream` events (delta + done flag)
5. **On exit**:
   - Extract `cli_session_id` from output (adapter-specific parsing)
   - Persist `cli_session_id` + `cli_session_path` to `agent_channel_states`
   - Record token delta from CLI stream-json output (`actual_input_tokens`, `output_tokens`)
   - Update `anchor_seq` to current_seq
   - Reset `idle_turn_count` to 0
   - Transition agent_channel_state status: absent→active, observing→active
   - Release spawn lock
6. **On error** (non-zero exit, OOM, timeout):
   - Emit `agent.error` WS event to channel
   - Release spawn lock
   - Log error (no auto-retry per handoff §8.4)

**WHY**: This is the heart of the system. The spawn lock (Invariant #3), presence check (Invariant #1), workspace resolution (Invariant #2), and env injection (Invariant #4, #5) all converge here. (Handoff §5.2, §5.3, §5.4, §6)

**VERIFY**:
```bash
# Unit test: spawn lock — two concurrent spawns for same agent → second waits
# Unit test: spawn lock — two spawns for different agents → both proceed
# Unit test: busy_task agent → spawn deferred, not rejected
# Unit test: env injection includes CHAT_API_TOKEN, CHAT_API_URL, CHAT_SESSION_ID
# Integration test: spawn claude --print → stdout streams to WS
# Integration test: cli_session_id extracted and persisted after run
# Integration test: non-zero exit → agent.error event emitted, lock released
# Integration test: timeout → process killed, error surfaced
```

---

### Task 2.2.4 — Session lifecycle (open/close)

**WHAT**: Extend `SessionManager.ts`:

`openSession(channelId, participantIds)`:
- Create `chat_sessions` row with defaults from constants
- For each agent participant: read `bootstrapPrompt` from Paperclip agent config
- Initialize `agent_channel_states` rows with `status='absent'`
- Resolve workspace per channel type (cache for session lifetime)
- Return session object

`closeSession(sessionId, crystallize)`:
- Set status='closed'
- If crystallize=true: use global_summary as Paperclip issue description (stub — Phase 4)
- Release any wakeup checkouts
- Emit `session.closed` WS event

Idle timeout: 10 minutes of no turns → auto-close (use `setInterval` or timer per session).

**WHY**: Sessions are the container for all conversation state. Open triggers workspace resolution and agent state initialization. Close cleans up resources. (Handoff §8.1)

**VERIFY**:
```bash
# Test: open session → chat_sessions row created with correct defaults
# Test: open session → agent_channel_states rows created for each agent (status=absent)
# Test: open session → bootstrapPrompt read from Paperclip and stored
# Test: close session → status=closed, session.closed WS event
# Test: idle 10 min → auto-close triggers
```

---

### Task 2.2.5 — bootstrapPrompt + first-turn injection

**WHAT**: Create the injection packet assembly for first-turn (absent agent) in `server/src/context/PacketAssembler.ts` (partial — full assembly in Phase 3):

First-turn packet structure (handoff §8.6, §9.1):
```
[bootstrapPrompt]           ← operator's agent instructions (first turn ONLY)
[context shift header]      ← "You are in group chat · paperclip-chat · #{channel}"
[global_summary if exists]  ← skip for first message in session
[verbatim tail K tokens]    ← recent turns (just the triggering message for first turn)
[new @mention message]      ← the message that triggered this
```

For subsequent turns (active agent): just `[verbatim tail] + [message]` — relies on `--resume`.

**WHY**: bootstrapPrompt integration ensures operator-configured agent behavior carries into chat. First-turn must set full context. Subsequent turns rely on CLI session continuity. (Handoff §8.6, §9.1, §9.2)

**VERIFY**:
```bash
# Unit test: absent agent first turn → packet includes bootstrapPrompt + context shift + message
# Unit test: active agent subsequent turn → packet is just verbatim tail + message (no bootstrapPrompt)
# Unit test: bootstrapPrompt is null/empty → packet still valid (skip layer)
# Unit test: context shift header includes channel name
```

---

### Task 2.2.6 — REST route: POST /api/sessions/:id/send

**WHAT**: Create route in `server/src/routes/sessions.ts`:
- Validate body with `sendMessageSchema`
- Authenticate (any principal)
- Call `sessionManager.processTurn()`
- Return `{ turn: Turn }` with 200

Also implement:
- `POST /api/sessions` → `sessionManager.openSession()`
- `GET /api/sessions/:id` → session state + recent turns
- `POST /api/sessions/:id/close` → `sessionManager.closeSession()`
- `GET /api/sessions/:id/tokens` → per-turn token usage
- `GET /api/channels/:id/messages` → cursor-paginated turn history

**WHY**: These are the core REST endpoints from handoff §13.1. The send endpoint is the entry point for all messages — human, agent, API. (Handoff §13.1)

**VERIFY**:
```bash
# Test: POST /send with valid message → 200, turn returned with token_count
# Test: POST /send with empty text → 400 (Zod validation)
# Test: POST /send unauthenticated → 401
# Test: GET /messages with cursor pagination → returns pages of 50 turns
# Test: GET /messages?cursor=X → returns turns after cursor
# Test: GET /sessions/:id → returns session + agent_channel_states
```

---

### Sprint 2.2 Gate

```
✅ PresenceStateMachine correctly blocks/allows spawns based on agent.status
✅ WorkspaceResolver returns correct paths per channel type
✅ SubprocessManager spawn lock prevents concurrent spawns per agent
✅ CLI subprocess spawns, streams stdout to WS, extracts cli_session_id
✅ Session open/close lifecycle works end-to-end
✅ bootstrapPrompt injected on first turn, not re-injected on resume
✅ All REST endpoints return correct responses with proper auth
✅ pnpm test:run passes
✅ pnpm typecheck passes
```

---

## ✅ PHASE 2 GATE — End-to-end chat works

```
FULL FLOW TEST:
  1. Boot Paperclip + chat-server
  2. Create DM channel with 1 human + 1 claude_local agent
  3. Human sends: "Hey @CEO, what's the status of our auth module?"
  4. Verify: turn appears in DB with token_count > 0
  5. Verify: chat.message WS event received by human client
  6. Verify: debounce buffer holds message for 800ms
  7. Verify: after 800ms, subprocess spawns with --print
  8. Verify: stdout streams to WS as chat.message.stream events
  9. Verify: on completion, cli_session_id persisted
  10. Human sends follow-up: "@CEO can you elaborate?"
  11. Verify: subprocess spawns with --resume {cli_session_id}
  12. Verify: agent responds with context from previous turn

CONCURRENCY TEST:
  13. Trigger Paperclip heartbeat for the agent
  14. While heartbeat running, send chat @mention
  15. Verify: chat spawn deferred (not executed)
  16. Heartbeat completes → chat spawn executes
  17. Verify: agent responds to the chat message

COALESCING TEST:
  18. Send 3 messages in rapid succession (< 800ms apart)
  19. Verify: agent receives all 3 as one batched prompt
  20. Verify: only 1 subprocess spawned

ALL TESTS PASS → Proceed to Phase 3
```

---

# PHASE 3 — Group Chat Context (Week 3, first half)

> Background chunker, global summary fold, full injection packet assembly, DM shortcut. After this phase: multi-agent group conversations work with sub-linear token growth.

---

## Sprint 3.1 — Chunker + summary fold (Days 12–14)

### Task 3.1.1 — Background chunker (ChunkWorker)

**WHAT**: Create `server/src/context/ChunkWorker.ts`:
- Trigger: `setImmediate()` when cumulative turn tokens since last chunk >= T_WINDOW (1200 default)
- Query turns in range `[lastChunkEnd+1, currentSeq]` WHERE `summarize=true`
- Call CLI sessionlessly: `claude --print 'Summarize this conversation segment...'` — no `--resume`, no session file
- Parse output, count summary tokens via js-tiktoken
- Insert `trunk_chunks` row with chunk_start, chunk_end, summary, summary_token_count, input_token_count
- Chain: `setImmediate(() => foldGlobalSummary(sessionId))`
- **Cost tracking**: After each cliSummarize(), POST to `/api/costs` with `billingCode: 'chat-context-management'` (handoff §8.5). Retry 3x, non-blocking on failure.
- **On error**: Mark chunk dirty=true, log, continue. Do not block chat. (Handoff §8.4)

**WHY**: Chunks are the building blocks for catch-up injection. Pre-computed summaries mean zero LLM calls in the @mention hot path. Token-window boundaries (not turn counts) ensure uniform chunk sizes. (Handoff §9.3, Key Invariant #6, #7)

**VERIFY**:
```bash
# Unit test: 20 turns totaling 1300 tokens → chunk created covering those turns
# Unit test: turns with summarize=false excluded from chunk input
# Unit test: chunk summary_token_count matches js-tiktoken count of summary text
# Unit test: after chunk insert, foldGlobalSummary is called
# Unit test: cliSummarize failure → chunk marked dirty, no crash
# Integration test: POST /api/costs called with correct billingCode
# Integration test: cost POST failure → logged, chat continues
```

---

### Task 3.1.2 — Global summary fold (SummaryFold)

**WHAT**: Create `server/src/context/SummaryFold.ts`:
- Called after each chunk write (chained via setImmediate)
- Read previous `session_summaries` row (or empty for first fold)
- Read latest `trunk_chunks` row
- Call CLI sessionlessly: `'Previous summary: {prev}\nNew events: {chunk_summary}\nUpdate. Keep under {SUMMARY_BUDGET} tokens. Compress older events more than recent ones.'`
- Count result tokens, upsert `session_summaries`
- **Cost tracking**: Same POST /api/costs pattern
- Emit `session.summary` WS event with `{ sessionId, text, tokenCount }`
- **On error**: Keep prior summary, log, retry on next chunk. (Handoff §8.4)
- **DM trigger**: For DM sessions (no chunker), fold every W_DM turns (default 10)

**WHY**: Global summary is the single most reused artifact — absent agent injection, crystallize, scrollback UI, search, re-onboarding. Bounded regardless of conversation length. (Handoff §9.4)

**VERIFY**:
```bash
# Unit test: first fold (no prior summary) → creates session_summaries row
# Unit test: subsequent fold → updates row, token_count <= SUMMARY_BUDGET
# Unit test: session.summary WS event emitted after fold
# Unit test: DM session → fold triggers at turn 10, 20, 30...
# Unit test: fold failure → prior summary preserved, no crash
```

---

### Task 3.1.3 — Full PacketAssembler

**WHAT**: Complete `server/src/context/PacketAssembler.ts`:

`assemblePacket(sessionId, agentParticipant, triggeringTurn)`:

Based on agent_channel_state.status:

| Status | Packet layers |
|--------|--------------|
| absent | bootstrapPrompt + context_shift + global_summary + verbatim_tail(K) + message |
| observing | context_shift + chunks[anchor..current-K] + verbatim_tail(K) + message (--resume) |
| active | verbatim_tail + message only (--resume, no chunks) |

Implementation:
- **ALL arithmetic, ZERO tokenizer calls** in hot path — use stored token_count values
- Verbatim tail: walk backwards from current_seq, accumulate turns until K_tokens budget exhausted
- Chunk query: `trunk_chunks WHERE session_id AND chunk_start > anchor_seq AND chunk_end < (current_seq - tail_start_seq)`
- Budget gate: if total > PACKET_BUDGET, drop middle chunks (keep first + last)
- **Hot shortcut**: if `current_seq - anchor_seq <= K_active_threshold` → agent is active, skip chunk query entirely. One turn-range scan only.
- Context shift header format:
```
You are currently in a group chat via paperclip-chat (channel: #{channelName}).
You were last active at turn {anchor_seq}. Here is what you missed:
[SUMMARY: ...]
[Recent turns verbatim]
[{senderName} @{agentName}]: {message}
```

**WHY**: This is the core architectural differentiator from handoff §9. Zero @mention latency (no LLM calls), sub-linear token growth (chunks + budget gate). The hot shortcut is the common case for active conversations. (Handoff §9.1, §9.2)

**VERIFY**:
```bash
# Unit test: absent agent → packet includes bootstrapPrompt + global_summary + tail + message
# Unit test: observing agent → packet includes chunks + tail + message, no bootstrapPrompt
# Unit test: active agent → packet is tail + message only (no chunk query)
# Unit test: hot shortcut fires when idle_turn_count < K_active_threshold
# Unit test: packet > PACKET_BUDGET → middle chunks dropped, first+last kept
# Unit test: zero tokenizer calls during assembly (mock and verify no calls)
# Unit test: verbatim tail respects K_tokens budget (walk backwards, not forward)
# Benchmark: assemblePacket for 100-turn session < 5ms (pure DB reads + arithmetic)
```

---

### Task 3.1.4 — AgentChannelState transitions

**WHAT**: Create `server/src/context/AgentChannelState.ts`:
- `transitionOnMention(sessionId, participantId)`: Returns current status for packet assembly
- `transitionOnCompletion(sessionId, participantId, newSeq)`: Update anchor_seq, set status to 'active', reset idle_turn_count
- `incrementIdle(sessionId, excludeParticipantId)`: Increment idle_turn_count for all other agents
- Status transition: absent→active (on first completion), observing→active (on any completion), active→observing (when idle_turn_count >= K_active_threshold)

**WHY**: Agent channel state drives which injection packet is assembled. anchor_seq determines catch-up range. idle_turn_count determines status transitions. (Handoff §9.1)

**VERIFY**:
```bash
# Unit test: new agent (absent) completes turn → transitions to active
# Unit test: active agent with idle_turn_count >= 5 → transitions to observing
# Unit test: observing agent completes turn → transitions to active, anchor updated
# Unit test: incrementIdle increments all agents except the sender
```

---

### Task 3.1.5 — DM shortcut

**WHAT**: In `SessionManager.processTurn()`, detect DM sessions (channel type='dm', 2 participants) and skip:
- No background chunker trigger
- No agent_channel_states management
- No chunk-based packet assembly
- Just `--print + --resume` every turn
- Global summary fold triggers every W_DM turns (10)

**WHY**: DMs are the degenerate case — agent's `--resume` session IS the conversation. No context injection overhead needed. (Handoff §9.5)

**VERIFY**:
```bash
# Test: DM session → no trunk_chunks rows created after 20 turns
# Test: DM session → no agent_channel_states rows (or ignored)
# Test: DM session → global summary fold triggers at turn 10 and 20
# Test: DM subprocess always uses --resume (after first turn)
```

---

### Sprint 3.1 Gate

```
✅ Chunker fires at correct token boundary, creates trunk_chunks rows
✅ Global summary fold creates/updates session_summaries, bounded by SUMMARY_BUDGET
✅ Background costs POST to Paperclip /api/costs with correct billingCode
✅ PacketAssembler builds correct packet per agent status (absent/observing/active)
✅ Hot shortcut skips chunk query for active agents
✅ Budget gate drops middle chunks when packet exceeds PACKET_BUDGET
✅ Zero tokenizer calls in assemblePacket hot path
✅ DM shortcut skips all chunk/state machinery
✅ Agent channel state transitions are correct
✅ pnpm test:run passes
```

---

## ✅ PHASE 3 GATE — Group chat works

```
GROUP CHAT TEST:
  1. Create company_general channel with 3 agents (CEO, CTO, Engineer)
  2. Human sends 15 messages (enough to trigger chunking at T_WINDOW=1200)
  3. Verify: trunk_chunks row created
  4. Verify: session_summaries row created
  5. @mention CEO (absent) → verify injection packet includes global_summary + tail
  6. CEO responds → agent_channel_state transitions to active
  7. Human sends 5 more messages
  8. @mention CEO again (active) → verify: tail + message only, no chunks
  9. Send 20 more messages without mentioning CEO
  10. @mention CEO (now observing) → verify: chunks + tail + context_shift
  11. @mention CTO (still absent) → verify: global_summary path used

DM VS GROUP TEST:
  12. Create DM with 1 agent
  13. Exchange 15 messages → verify: no trunk_chunks created
  14. Verify: global_summary created at turn 10

ALL TESTS PASS → Proceed to Phase 4
```

---

# PHASE 4 — Agent-Initiated + SKILL.md + Crystallize (Week 3, second half)

---

## Sprint 4.1 — (Days 15–17)

### Task 4.1.1 — SKILL.md authoring

**WHAT**: Create `server/src/skills/paperclip-chat/SKILL.md`:

Must teach agents:
- When to use chat vs issue comments (decision table from handoff §11.1)
- How to post: `POST $CHAT_API_URL/api/sessions/{id}/send` with `CHAT_API_TOKEN`
- `[DECISION]` prefix protocol
- `/crystallize` command
- Env vars available: `CHAT_API_URL`, `CHAT_SESSION_ID`, `CHAT_API_TOKEN`
- Channel lookup: `GET $CHAT_API_URL/api/channels`
- Rate limit: 20 messages per minute per agent (mention limit)

Serve at `GET /api/skills/paperclip-chat` (public, no auth).

Also: embed core protocol inline in first-turn injection prompt as skill staleness fallback.

**WHY**: Agents learn chat protocol at runtime via SKILL.md. Stale skill defence (inline injection) ensures agents work even if skill symlink is broken. (Handoff §11.1, §11.2)

**VERIFY**:
```bash
# GET /api/skills/paperclip-chat → returns markdown
# Verify: contains all env var references
# Verify: contains decision table (when to use chat vs comments)
# Verify: contains exact POST endpoint with auth header example
# Verify: first-turn injection includes inline protocol even without SKILL.md
```

---

### Task 4.1.2 — Agent-initiated turn pipeline

**WHAT**: Agent messages flow through the same `processTurn()` as human messages. Additional behavior:
- When turn is from an agent AND is the first turn in a session → emit `agent.initiated_chat` WS event with `{ agentId, taskId (from content ref), channelId, message_preview }`
- Create notification for all human participants (type: 'agent_initiated')
- Rate limit: 20 messages per minute per agent on `POST /api/sessions/:id/send` → return 429 with clear message if exceeded

**WHY**: Agents are first-class participants. The initiated_chat event drives the "blocked agent needs human" notification pattern. Rate limit prevents malfunctioning agents from spamming. (Handoff §11, §8.4)

**VERIFY**:
```bash
# Test: agent POST /send → turn created, chat.message broadcast
# Test: first agent message in session → agent.initiated_chat WS event
# Test: notification created for offline humans with type='agent_initiated'
# Test: 21st message in 1 minute → 429 response
# Test: rate limit resets after 1 minute
```

---

### Task 4.1.3 — [DECISION] detection + crystallize

**WHAT**:
- In `processTurn()`: if turn content starts with `[DECISION]`, set `is_decision=true` and emit `session.decision` WS event
- `POST /api/sessions/:id/close { crystallize: true }`:
  - Read `session_summaries.text` for this session
  - POST to Paperclip `POST /api/companies/:id/issues` with global_summary as issue description
  - Write para-memory file: `{sessionId}-crystallize.md` to agent home workspace containing summary + decision + participant list
  - Close session
  - Return `{ paperclipIssueId }` in response

**WHY**: Crystallize is the bridge back to Paperclip's task system — chat decisions become real work items. Zero extra LLM call because global_summary is already fresh. Para-memory gives agents continuity. (Handoff §9.4, §14 Phase 4)

**VERIFY**:
```bash
# Test: [DECISION] turn → is_decision=true in DB, session.decision WS event
# Test: crystallize → Paperclip issue created with summary as description
# Test: crystallize → para-memory file written to correct path
# Test: crystallize with no summary → falls back to last good summary + verbatim tail
# Test: crystallize → session status = closed
```

---

### Task 4.1.4 — Notification REST endpoints

**WHAT**:
- `GET /api/notifications` (human auth only) → unread notifications for this user, ordered by created_at desc
- `POST /api/notifications/read` (human auth only) → mark all or specific notifications as read (set `read_at`)
- `notification.new` WS event → pushed to connected human clients when notification created

**WHY**: Humans must see agent requests on next login even if they weren't connected when the agent posted. (Handoff §10)

**VERIFY**:
```bash
# Test: GET /notifications → returns only unread for this user
# Test: POST /notifications/read → sets read_at, subsequent GET excludes them
# Test: notification.new WS event delivered to connected human
# Test: agent auth → 401 on /notifications (human only)
```

---

### Sprint 4.1 Gate + Phase 4 Gate (combined — small phase)

```
✅ SKILL.md served at public endpoint with complete protocol
✅ Agent-initiated messages create notifications + WS event
✅ Rate limiting works (429 on excess)
✅ [DECISION] detection and session.decision event work
✅ Crystallize creates Paperclip issue from global_summary
✅ Para-memory file written on crystallize
✅ Notification CRUD endpoints work with correct auth
✅ notification.new WS event fires for connected clients
```

---

# PHASE 5 — UI (Week 4)

> Build the chat interface. After this phase: fully functional chat UI matching Paperclip's visual language.

---

## Sprint 5.1 — Sidebar + routing (Days 18–19)

### Task 5.1.1 — App shell + routing

**WHAT**: Set up the React app:
- Vite config matching Paperclip's (`vite.config.ts`)
- shadcn/ui init with Paperclip's `components.json` config
- Install shadcn components: Button, Dialog, ScrollArea, Avatar, Badge, Tooltip, DropdownMenu, Input, Textarea, Popover, Command, Skeleton, Sheet
- TanStack React Query setup with `QueryClientProvider`
- Routes: `/` (redirect to first channel), `/channels/:id` (chat thread), `/notifications`
- `lib/queryKeys.ts` with chat key factories
- `lib/utils.ts` with `cn()` utility
- `api/chat.ts` with all fetch functions

**WHY**: Foundation for all UI work. Must match Paperclip's tooling exactly. (DESIGN_SYSTEM §1, §2)

**VERIFY**:
```bash
pnpm build                      # UI builds without errors
# Dev server loads without console errors
# shadcn components render correctly
# React Query devtools visible in dev mode
```

---

### Task 5.1.2 — Sidebar component

**WHAT**: `ui/src/components/Sidebar.tsx`:
- Channel list grouped by type: "Channels" (company_general + project), "Direct Messages" (dm), "Threads" (task_thread)
- Each row: presence dot + channel name + unread badge + last message preview + timestamp
- Unread state: bold text + blue dot for channels with unread turns (query `notifications` or compute from last_read_at)
- "Pending agent requests" section: amber treatment, channels where agent_initiated notification is unread
- Create DM button → opens participant picker (agent list from Paperclip)
- Selected channel: `bg-muted` background
- Responsive: collapses to sheet on mobile

**WHY**: Primary navigation. Must match Paperclip's sidebar density and IssueRow visual pattern. (DESIGN_SYSTEM §4, §5)

**VERIFY**:
```bash
# Visual: channels grouped correctly
# Visual: unread badges show correct counts
# Visual: pending agent requests section appears when applicable
# Interaction: click channel → navigates to /channels/:id
# Interaction: create DM → opens picker, creates channel on confirm
# Responsive: sidebar collapses on < 768px
```

---

### Task 5.1.3 — WebSocket hook

**WHAT**: `ui/src/hooks/useChatWebSocket.ts`:
- Connect on mount, authenticate via cookie (or token in query param)
- Subscribe to current channel
- Handle all CHAT_EVENT_TYPES:
  - `chat.message` → append to React Query message cache
  - `chat.message.stream` → update streaming state (in-progress message)
  - `agent.typing` → update typing indicator state
  - `agent.status` → update presence state
  - `session.decision` → show decision banner
  - `session.summary` → update summary display
  - `session.tokens` → update token counter
  - `notification.new` → increment unread count, show toast for agent_initiated
- Reconnect with exponential backoff
- On reconnect: send `last_seq`, process catch-up events

**WHY**: WS is the real-time backbone. All live updates flow through this hook into React Query cache — single source of truth. (CODING_GUIDELINES §5.2)

**VERIFY**:
```bash
# Test: receives chat.message → message appears in thread without refetch
# Test: receives chat.message.stream → tokens appear incrementally
# Test: WS disconnect → auto-reconnects within 5s
# Test: reconnect → catch-up events processed (no missing messages)
```

---

## Sprint 5.2 — Chat thread + input (Days 20–22)

### Task 5.2.1 — ChatThread component

**WHAT**: `ui/src/components/ChatThread.tsx`:
- Fetch message history via `GET /api/channels/:id/messages` (cursor-paginated)
- Render messages as flat rows (NOT bubbles — see DESIGN_SYSTEM §8 anti-patterns):
  - Agent avatar + name on left
  - Message content with markdown rendering
  - Timestamp right-aligned, `text-xs text-muted-foreground`
  - Token cost indicator (small, inline) if message is from agent
  - [DECISION] messages: highlighted with amber/warning border
- Streaming: in-progress message shows tokens appearing with cursor
- Typing indicator: pulsing dots when `agent.typing` received
- Infinite scroll up for history (load older pages)
- Auto-scroll to bottom on new message (unless user has scrolled up)

**WHY**: Main content area. Must feel like Paperclip's RunTranscriptView — flat, dense, professional. Not like iMessage or Discord. (DESIGN_SYSTEM §4 "Live streaming pattern")

**VERIFY**:
```bash
# Visual: messages render with markdown (bold, code blocks, lists)
# Visual: agent messages show avatar + name
# Visual: streaming message shows progressive token render
# Visual: [DECISION] message has amber border
# Interaction: scroll up → loads older messages
# Interaction: new message while scrolled up → "new messages" banner, not forced scroll
```

---

### Task 5.2.2 — MessageInput component

**WHAT**: `ui/src/components/MessageInput.tsx`:
- Textarea (shadcn) with auto-resize
- Send on Enter, newline on Shift+Enter
- @mention autocomplete: type `@` → dropdown of channel participants (agents + humans)
- Optimistic send: message appears immediately in thread, confirmed on server response
- Disable while agent is responding (show "Agent is responding..." state)
- Character limit indicator (10,000 chars per sendMessageSchema)

**WHY**: Primary input. @mention is the trigger for agent invocation — autocomplete makes it discoverable. Optimistic send makes chat feel instant. (Handoff §8.3 step 5)

**VERIFY**:
```bash
# Interaction: Enter sends, Shift+Enter adds newline
# Interaction: type @ → participant dropdown appears
# Interaction: select participant → @name inserted in text
# Visual: sent message appears immediately (optimistic)
# Visual: send fails → message marked with error indicator
```

---

### Task 5.2.3 — SummaryBar, CrystallizeCard, NotificationPanel

**WHAT**:

`SummaryBar.tsx`: Collapsible panel at top of chat thread. Shows `session_summaries.text` when user scrolls past visible history. Token count badge. "Crystallize" button.

`CrystallizeCard.tsx`: Dialog triggered from SummaryBar. Shows summary preview, confirm/cancel. On confirm: `POST /api/sessions/:id/close { crystallize: true }`. Shows resulting Paperclip issue link.

`NotificationPanel.tsx`: Accessible from sidebar. Lists unread notifications grouped by type. Agent-initiated requests get priority treatment (amber). Click → navigate to channel. Mark as read on view.

**WHY**: SummaryBar gives humans context on long conversations. CrystallizeCard is the chat→task bridge. NotificationPanel ensures offline humans see agent requests. (Handoff §9.4, §10)

**VERIFY**:
```bash
# SummaryBar: shows when scrolled up, hides when at bottom
# SummaryBar: token count badge matches session_summaries.token_count
# CrystallizeCard: confirm → Paperclip issue created, link shown
# NotificationPanel: unread notifications listed, mark-read works
# NotificationPanel: agent_initiated notifications have amber treatment
```

---

### Sprint 5.2 Gate + Phase 5 Gate

```
✅ Full UI renders: sidebar + thread + input
✅ Messages send and appear in real-time (WS)
✅ Agent responses stream token-by-token
✅ @mention autocomplete works
✅ Unread badges update correctly
✅ Notifications panel shows agent requests
✅ Crystallize creates Paperclip issue from UI
✅ SummaryBar shows conversation summary
✅ Responsive layout works on mobile viewport
✅ Visual review: looks like it belongs in Paperclip (same shadcn, same density, same colors)
```

---

# PHASE 6 — paperclip_wakeup + Hardening (Week 5)

> Add support for http/process adapters, session persistence, reconnection, rate limiting.

---

## Sprint 6.1 — paperclip_wakeup adapter (Days 23–24)

### Task 6.1.1 — Scaffold issue pattern

**WHAT**: For `paperclip_wakeup` agents (adapterType: http, process):
- On session open: create Paperclip issue titled `[CHAT] #{channel} / {session_id[:8]}`, labeled `chat-session`
- Checkout the issue for the agent
- On each @mention: POST batched comment to scaffold issue, then wakeup with `source='automation'`, `reason='issue_comment_mentioned'`, `wakeCommentId` (CRITICAL: must use exactly these values — handoff Key Invariant #4)
- Subscribe Paperclip WS for `heartbeat.run.log` → pipe to WS as `agent.run.log`

**WHY**: wakeup agents can't be spawned as subprocesses. They use Paperclip's existing heartbeat machinery, triggered by comments on a scaffold issue. (Handoff §3.1)

**VERIFY**:
```bash
# Test: session open with http agent → scaffold issue created in Paperclip
# Test: @mention → comment posted + wakeup triggered with correct source/reason
# Test: wrong wakeup reason → test demonstrates session would be reset (document this)
# Test: run.log events stream to chat WS
```

---

## Sprint 6.2 — Hardening (Days 25–26)

### Task 6.2.1 — Session persistence across restarts

**WHAT**: On chat-server restart:
- Rebuild active sessions from DB (`chat_sessions WHERE status='active'`)
- Restore cli_session_id + cli_session_path from agent_channel_states
- Re-subscribe Paperclip WS for agent.status events
- Re-checkout scaffold issues for active wakeup sessions
- Resume idle timers

**WHY**: Server crash/restart must not lose active conversations. (Handoff §14 Phase 6)

**VERIFY**:
```bash
# Test: restart chat-server mid-session → session resumes
# Test: restart → cli_session_id preserved, --resume works on next turn
# Test: restart → scaffold issue checkouts re-established
```

---

### Task 6.2.2 — WS reconnect with catch-up

**WHAT**:
- Client sends `last_seq` on WS reconnect
- Server queries `turns WHERE session_id AND seq > last_seq`
- Replays as `chat.message` events
- Client reconciles with React Query cache (deduplicate by turn.id)

**WHY**: Network interruptions must not cause missing messages. (Handoff §8.4, §14 Phase 6)

**VERIFY**:
```bash
# Test: disconnect during message → reconnect → missed message delivered
# Test: reconnect with last_seq=50, 5 new turns → all 5 replayed
# Test: duplicate turn.id → deduplicated in client cache
```

---

### Task 6.2.3 — Rate limiting + scaffold label filter

**WHAT**:
- Rate limit Paperclip API calls: max 60/min for non-critical, 10/min for wakeup
- Rate limit agent POST /send: 20/min per agent (from Task 4.1.2)
- Filter scaffold issues from Paperclip board views via `chat-session` label

**WHY**: Prevent chat-server from overwhelming Paperclip's API. Keep scaffold issues hidden from the task board. (Handoff §14 Phase 6)

**VERIFY**:
```bash
# Test: 61st Paperclip API call in 1 min → delayed (not rejected)
# Test: scaffold issues have 'chat-session' label
# Test: Paperclip board filtered to exclude chat-session label
```

---

## ✅ PHASE 6 GATE — Production ready

```
FULL SYSTEM TEST:
  1. Boot Paperclip with multiple agents (claude_local + http adapter)
  2. Boot chat-server
  3. Human chats with claude_local agent → full flow works
  4. Human chats in group with 3 agents → context strategy works
  5. Agent initiates chat (blocked on task) → human notified
  6. Human responds → agent unblocks task
  7. Crystallize → Paperclip issue created
  8. @mention http agent → scaffold issue + wakeup flow works
  9. Restart chat-server → sessions resume, no data loss
  10. WS disconnect/reconnect → no missing messages
  11. Rapid messages → coalesced correctly
  12. 100+ turns in group chat → token costs sub-linear (verify with /api/sessions/:id/tokens)

PERFORMANCE BENCHMARKS:
  - assemblePacket for 200-turn session: < 10ms
  - processTurn end-to-end (DB + WS broadcast): < 50ms
  - First message latency (session open + workspace resolve + spawn): < 3s
  - Subsequent message (--resume): < 2s to first token

ALL PASS → Ship v1 🚀
```

---

# Summary — task count by phase

| Phase | Sprints | Tasks | Calendar |
|-------|---------|-------|----------|
| 1 — Foundation | 3 | 12 | Week 1 |
| 2 — subprocess_cli | 2 | 9 | Week 2 |
| 3 — Group chat context | 1 | 5 | Week 3 (first half) |
| 4 — Agent-initiated + crystallize | 1 | 4 | Week 3 (second half) |
| 5 — UI | 2 | 6 | Week 4 |
| 6 — Wakeup + hardening | 2 | 4 | Week 5 |
| **Total** | **11** | **40** | **5 weeks** |

---

*paperclip-chat implementation spec · derived from handoff v6 · every task traces to a handoff section*
