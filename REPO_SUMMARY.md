# Paperclip Chat — Repository Summary

## What Is This?

Paperclip Chat is an **agent-native multi-agent chat surface** that mirrors Paperclip's collaboration model. It provides a shared room where multiple AI agents and humans can collaborate on tasks, with each agent maintaining individual identity and context without disrupting the shared conversation.

## Key Capabilities

- **Multi-agent coordination** — multiple agents collaborate in shared channels with mention-aware dispatch (`@name`)
- **Rolling context trimming** — keeps LLM token costs stable with chunked summarization and fold injection
- **Crystallize checkpoints** — converts chat decisions into durable Paperclip issues
- **WebSocket live sync** — real-time streaming of agent output and presence to the UI
- **Identity-aware prompts** — agents identify as named roles (e.g., "tester", "eagle"), not generic assistants

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript (strict, ESM, ES2022+) |
| Runtime | Node.js 24+ |
| Package Manager | pnpm workspaces |
| Backend | Express 5.2, Drizzle ORM 0.38 |
| Database | PostgreSQL |
| Frontend | React 19, Vite 6, TailwindCSS 4 |
| State | React Query 5.9, React Router 7 |
| WebSocket | `ws` (raw, no Socket.IO) |
| Auth | JWT (`js-tiktoken` for token counting) |
| Testing | Vitest 3.0 |

## Monorepo Structure

```
paperclip-chat/
├── server/          # Express API, business logic, WS hub
├── ui/              # React frontend
├── packages/
│   ├── shared/      # Types, validators, constants (shared across packages)
│   └── db/          # Drizzle schema + SQL migrations
└── orchestrator/    # Runtime lifecycle and workflow management
```

## Core Server Modules

| Module | Purpose |
|---|---|
| `session/SessionManager` | Orchestrates turn processing, mention parsing, crystallize |
| `context/TrunkManager` | Manages turns, chunk summaries, and session summaries |
| `context/ChunkWorker` | Background summarizer — coalesces turns, manages token budget |
| `subprocess/SubprocessManager` | Spawns CLI agents, streams stdout to WS |
| `ws/hub` | WebSocket server with per-channel subscriptions |
| `adapters/paperclipClient` | REST client to Paperclip API with retry + tracing |

## Database Schema (Drizzle + PostgreSQL)

Tables: `channels`, `sessions`, `participants`, `turns`, `chunks`, `summaries`

Key fields:
- `turns.seq` — per-session sequence number (monotonic, gapless)
- `turns.isDecision` — decision turns always included in context
- `turns.mentionedIds` — parsed @mentions for dispatch routing
- `sessions.lastCrystallizedSeq` / `lastCrystallizedIssueId` — crystallize state

Migrations in `packages/db/drizzle/`.

## Context Management (Trunk)

To keep token usage bounded while preserving important history:

1. **Verbatim tail** (`K_TOKENS=800`) — last N turns kept as-is
2. **Chunk window** (`T_WINDOW=1200`) — older turns summarized when budget exceeded
3. **Fold** — summaries prior to the chunk window injected as a context packet
4. **Decision tracking** — turns marked `isDecision=true` always included
5. **Per-agent anchor** — each agent's context starts from their `anchorSeq`, not session start

## Agent Lifecycle

1. Human/agent sends turn → `POST /api/sessions/{id}/send`
2. `SessionManager` parses mentions, validates participants, stores turn in DB
3. `DebounceBuffer` coalesces rapid turns (800ms window)
4. `ChunkWorker` monitors token window, triggers summarization at boundary
5. `AgentDispatchCoordinator` identifies target agents, pulls pending context
6. `SubprocessManager` spawns CLI agent with `CHAT_SESSION_ID` + `CHAT_API_TOKEN`
7. Agent reads context from `GET /api/sessions/{id}` (turns + chunks + summaries)
8. Agent stdout streamed to UI via WS `chat.message.stream` events
9. On exit: tokens extracted, spawn lock released

## WebSocket Events

```
chat.message           — new turn from human or agent
chat.message.stream    — streaming agent output chunk
agent.typing           — agent typing indicator
agent.status           — presence change (absent | observing | active)
agent.run.log          — agent subprocess log line
session.summary        — rolling context summary updated
session.tokens         — token usage update
notification.new       — new notification
```

Envelope format: `{ type, payload, timestamp }`

## Key Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `PAPERCLIP_API_URL` | Paperclip backend URL |
| `CHAT_SERVICE_KEY` | Long-lived auth for chat→Paperclip calls |
| `CHAT_TOKEN_SECRET` | JWT signing secret for agent tokens |
| `COALESCE_MS` | Debounce window (default 800ms) |
| `T_WINDOW` | Chunk window target tokens (default 1200) |

## Development

```bash
pnpm install         # install all workspace deps
pnpm dev             # run server + UI concurrently
pnpm typecheck       # type check all packages
pnpm test:run        # run all tests once
pnpm db:generate     # generate new Drizzle migration
pnpm db:migrate      # apply migrations
```

## Key Docs

- `README.md` — project overview and getting started
- `PAPERCLIP_CODING_GUIDELINES.md` — coding standards (12 sections)
- `server/src/skills/paperclip-chat/SKILL.md` — agent skill definition
