# paperclip-chat · Coding Guidelines & Architecture Rules

> Reference doc for coding agents building paperclip-chat.
> Goal: code must follow Paperclip's existing patterns so a contributor moving between repos feels no friction.

---

## 1. Language and runtime

Everything is TypeScript. No JavaScript files, no `any` types without explicit justification.

| Setting | Value | Notes |
|---------|-------|-------|
| TypeScript | Strict mode | Match Paperclip's tsconfig |
| Node.js target | Node 24 (since v0.3.0 Docker) | ES2022+ features OK |
| Module system | ESM (`"type": "module"` in package.json) | Use `import`/`export`, never `require` |
| Package manager | pnpm (workspace protocol) | Never npm or yarn |

---

## 2. Monorepo structure — mirror Paperclip's layout

Paperclip's structure:

```
paperclip/
├── cli/                    # paperclipai npm binary
├── server/                 # @paperclipai/server (Express)
│   └── src/
│       ├── routes/         # Express route handlers
│       ├── services/       # Business logic (heartbeat.ts, issues.ts)
│       ├── realtime/       # WebSocket server (live-events-ws.ts)
│       └── __tests__/      # Colocated tests
├── ui/                     # React frontend (Vite)
│   └── src/
│       ├── api/            # API client functions
│       ├── components/     # React components
│       │   ├── ui/         # shadcn primitives (don't modify)
│       │   └── transcript/ # domain-specific component groups
│       ├── hooks/          # Custom React hooks
│       ├── lib/            # Utilities (queryKeys.ts, inbox.ts, utils.ts)
│       └── pages/          # Page-level components
└── packages/
    ├── shared/             # Types, Zod schemas, constants, API prefixes
    ├── db/                 # Drizzle ORM schema + migrations
    └── adapter-utils/      # Adapter interfaces, TranscriptEntry types
```

paperclip-chat should follow the **same shape**:

```
paperclip-chat/
├── server/src/
│   ├── auth/               # validateHuman.ts, validateAgent.ts, chatTokens.ts, serviceAccount.ts
│   ├── adapters/           # paperclipClient.ts, paperclipWs.ts
│   ├── subprocess/         # SubprocessManager.ts, PresenceStateMachine.ts, WorkspaceResolver.ts
│   ├── context/            # TrunkManager.ts, ChunkWorker.ts, SummaryFold.ts, PacketAssembler.ts
│   ├── session/            # SessionManager.ts, Debounce.ts, crystallize.ts, scaffoldIssue.ts
│   ├── notifications/      # NotificationService.ts
│   ├── channels/           # Channel CRUD, participant management
│   ├── ws/                 # WebSocket hub, per-channel routing, event types
│   ├── routes/             # Express route handlers
│   └── __tests__/          # Tests colocated with server
├── ui/src/
│   ├── api/                # Chat API client functions
│   ├── components/
│   │   ├── ui/             # shadcn primitives (copied from Paperclip's ui/components.json config)
│   │   ├── Sidebar.tsx
│   │   ├── ChatThread.tsx
│   │   ├── CrystallizeCard.tsx
│   │   ├── SummaryBar.tsx
│   │   └── NotificationPanel.tsx
│   ├── hooks/              # useWebSocket, useChatMessages, usePresence, etc.
│   ├── lib/                # queryKeys.ts, utils.ts (cn utility)
│   └── pages/
└── packages/shared/        # Types, constants, Zod validators shared between server and UI
```

### Key rules

- **File naming**: PascalCase for components (`SessionManager.ts`, `ChatThread.tsx`), camelCase for utilities (`queryKeys.ts`, `paperclipClient.ts`). Match Paperclip exactly.
- **One export per file** for major classes/components. Small helpers can coexist.
- **Colocate tests**: `__tests__/` directories at the same level as the code they test (see `server/src/__tests__/`).
- **No barrel files** (`index.ts` re-exporting everything). Import directly from the source file.

---

## 3. Server patterns

### 3.1 Express route pattern

Paperclip's routes follow this pattern (see `server/src/routes/agents.ts`, `server/src/routes/issues.ts`):

```typescript
// routes/sessions.ts
import { Router } from 'express'
import { z } from 'zod'
import { sessionService } from '../session/SessionManager'

const router = Router()

// Validate with Zod, call service, return JSON
router.post('/api/sessions/:id/send', async (req, res) => {
  const { id } = req.params
  const body = sendMessageSchema.parse(req.body)       // Zod validation at route level
  const result = await sessionService.processTurn(id, body)  // Service does the work
  res.json(result)
})

export default router
```

Rules:
- **Routes are thin**: Parse params, validate body with Zod, call a service, return JSON. No business logic in routes.
- **Services hold business logic**: `SessionManager.ts`, `TrunkManager.ts`, etc. These are where processTurn, assemblePacket, computeChunk live.
- **Zod at the boundary**: Every incoming body/query is validated with a Zod schema. Schemas live in `packages/shared/src/validators/`.
- **Error handling**: Express async errors should be caught. Use a middleware or try/catch. Paperclip returns 4xx with `{ error: string }` JSON.

### 3.2 Service pattern

Paperclip services are **stateful singletons** initialized at startup (see `heartbeat.ts` which is ~1100 lines). Follow the same pattern:

```typescript
// session/SessionManager.ts
class SessionManager {
  private db: Database
  private paperclipApi: PaperclipClient
  private subprocessManager: SubprocessManager

  constructor(deps: { db: Database, paperclipApi: PaperclipClient, ... }) {
    this.db = deps.db
    this.paperclipApi = deps.paperclipApi
    // ...
  }

  async openSession(channelId: string, participantIds: string[]): Promise<ChatSession> {
    // ...
  }

  async processTurn(sessionId: string, message: SendMessage): Promise<Turn> {
    // This is the core function — see v6 handoff §8.3
  }
}

export const sessionManager = new SessionManager({ db, paperclipApi, ... })
```

Rules:
- **Constructor injection** for dependencies (db, API clients, other services)
- **Export a singleton** at module level
- **Methods are async** — everything touches DB or spawns processes
- **Line count**: Services can be long (heartbeat.ts is 1100 lines). Don't split prematurely. One file per domain concern is fine.

### 3.3 Database / Drizzle ORM pattern

Paperclip uses Drizzle ORM with PostgreSQL. Schema lives in `packages/db/src/schema/`.

```typescript
// packages/db/src/schema/chat.ts
import { pgTable, text, integer, timestamp, boolean, uuid, serial } from 'drizzle-orm/pg-core'

export const turns = pgTable('turns', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => chatSessions.id),
  seq: serial('seq').notNull(),
  fromParticipantId: uuid('from_participant_id').notNull(),
  content: text('content').notNull(),
  tokenCount: integer('token_count').notNull(),
  summarize: boolean('summarize').notNull().default(true),
  mentionedIds: text('mentioned_ids').array(),
  isDecision: boolean('is_decision').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

Rules:
- **Table names**: snake_case in SQL, camelCase in TypeScript (Drizzle convention)
- **UUIDs for IDs**: Paperclip uses UUIDs everywhere. So should chat.
- **Timestamps**: Always `timestamp('created_at').notNull().defaultNow()`
- **Foreign keys**: Explicit `.references(() => otherTable.id)`
- **Migrations**: `pnpm db:generate` creates a migration file, `pnpm db:migrate` applies it. Migrations are **additive only** (no destructive changes in production) — Paperclip's v0.3.0 release notes emphasize this.
- **Indexes**: Create explicit indexes for query patterns. Paperclip has indexes on frequently queried columns.

### 3.4 Paperclip REST client pattern

chat-server calls Paperclip's API frequently. Use a typed client:

```typescript
// adapters/paperclipClient.ts
class PaperclipClient {
  private baseUrl: string
  private serviceKey: string

  constructor(baseUrl: string, serviceKey: string) {
    this.baseUrl = baseUrl
    this.serviceKey = serviceKey
  }

  async getAgent(agentId: string): Promise<Agent> {
    const res = await fetch(`${this.baseUrl}/api/agents/${agentId}`, {
      headers: {
        'Authorization': `Bearer ${this.serviceKey}`,
        'X-Paperclip-Run-Id': `chat-server-${crypto.randomUUID()}`,
      }
    })
    if (!res.ok) throw new PaperclipApiError(res.status, await res.text())
    return agentSchema.parse(await res.json())  // Zod validate the response
  }
}
```

Rules:
- **Always include `X-Paperclip-Run-Id`** for audit trail (Paperclip uses this for tracing)
- **Zod-validate responses** from Paperclip — don't trust external API responses
- **Retry with backoff** for 5xx errors (see v6 handoff §8.4 error handling matrix)
- **Never log the service key** in error messages

### 3.5 WebSocket pattern

Paperclip's WS server is in `server/src/realtime/live-events-ws.ts`. It uses the raw `ws` library (not Socket.IO).

```typescript
// ws/hub.ts
import { WebSocketServer, WebSocket } from 'ws'

// Event types — define as constants, same as Paperclip's LIVE_EVENT_TYPES pattern
export const CHAT_EVENT_TYPES = {
  CHAT_MESSAGE: 'chat.message',
  CHAT_MESSAGE_STREAM: 'chat.message.stream',
  AGENT_TYPING: 'agent.typing',
  AGENT_STATUS: 'agent.status',
  AGENT_INITIATED_CHAT: 'agent.initiated_chat',
  SESSION_DECISION: 'session.decision',
  SESSION_SUMMARY: 'session.summary',
  SESSION_TOKENS: 'session.tokens',
  SESSION_CLOSED: 'session.closed',
  NOTIFICATION_NEW: 'notification.new',
} as const

// Message envelope — same structure as Paperclip's WS messages
interface WsEnvelope {
  type: string
  payload: unknown
  timestamp: string
}
```

Rules:
- **Use raw `ws`** — not Socket.IO. Paperclip uses `ws` library directly.
- **Envelope format**: `{ type, payload, timestamp }`. Be consistent.
- **Per-channel subscriptions**: Clients subscribe to channels. Server routes messages only to subscribers.
- **Ping/pong**: Implement keepalive. Paperclip's WS does this.
- **Reconnect with catch-up**: On reconnect, client sends `last_seq`. Server replays turns from that seq.

---

## 4. Shared types and constants

### 4.1 Type definitions

Paperclip defines all shared types in `packages/shared/src/types/`. Follow the same pattern:

```typescript
// packages/shared/src/types/chat.ts
export interface Turn {
  id: string
  sessionId: string
  seq: number
  fromParticipantId: string
  content: string
  tokenCount: number
  summarize: boolean
  mentionedIds: string[]
  isDecision: boolean
  createdAt: string
}

export interface ChatSession {
  id: string
  channelId: string
  status: 'active' | 'closed'
  currentSeq: number
  chunkWindowWTokens: number
  verbatimKTokens: number
}

export type AgentChannelStatus = 'absent' | 'observing' | 'active'
export type ChannelType = 'company_general' | 'project' | 'dm' | 'task_thread'
export type ChatPresence = 'available' | 'busy_task' | 'busy_dm' | 'offline'
```

### 4.2 Constants

Paperclip centralizes constants in `packages/shared/src/constants.ts`. Follow the same:

```typescript
// packages/shared/src/constants.ts
export const CHAT_DEFAULTS = {
  T_WINDOW: 1200,              // tokens — chunk window target
  K_TOKENS: 800,               // tokens — verbatim tail budget
  PACKET_BUDGET: 3000,         // tokens — hard cap on injection packet
  SUMMARY_BUDGET_DM: 500,      // tokens — global summary cap for DMs
  SUMMARY_BUDGET_GROUP: 600,   // tokens — global summary cap for group chats
  COALESCE_MS: 800,            // ms — debounce window
  K_ACTIVE_THRESHOLD: 5,       // turns — below this = 'active' status
  W_DM: 10,                    // turns — DM summary fold trigger
  CHAT_TOKEN_EXPIRY: '10m',    // CHAT_API_TOKEN lifetime
} as const
```

### 4.3 API prefixes

Paperclip declares all API prefixes in `packages/shared/src/api.ts`. Chat should do the same:

```typescript
// packages/shared/src/api.ts
export const CHAT_API = {
  CHANNELS: '/api/channels',
  CHANNEL_MESSAGES: (id: string) => `/api/channels/${id}/messages`,
  CHANNEL_SUMMARY: (id: string) => `/api/channels/${id}/summary`,
  SESSIONS: '/api/sessions',
  SESSION: (id: string) => `/api/sessions/${id}`,
  SESSION_SEND: (id: string) => `/api/sessions/${id}/send`,
  SESSION_CLOSE: (id: string) => `/api/sessions/${id}/close`,
  SESSION_TOKENS: (id: string) => `/api/sessions/${id}/tokens`,
  NOTIFICATIONS: '/api/notifications',
  NOTIFICATIONS_READ: '/api/notifications/read',
  SKILL: '/api/skills/paperclip-chat',
} as const
```

### 4.4 Zod validators

Paperclip validates all inputs with Zod (see `packages/shared/src/validators/`). Chat must do the same:

```typescript
// packages/shared/src/validators/chat.ts
import { z } from 'zod'

export const sendMessageSchema = z.object({
  text: z.string().min(1).max(10000),
})

export const openSessionSchema = z.object({
  participantIds: z.array(z.string().uuid()).min(1),
})

export const closeSessionSchema = z.object({
  crystallize: z.boolean().optional().default(false),
})
```

---

## 5. UI patterns

### 5.1 React Query — data fetching

Paperclip uses TanStack React Query exclusively for server state. See `ui/src/api/heartbeats.ts` and `ui/src/lib/queryKeys.ts`.

```typescript
// lib/queryKeys.ts — factory pattern for type-safe query keys
export const chatKeys = {
  all: ['chat'] as const,
  channels: () => [...chatKeys.all, 'channels'] as const,
  channel: (id: string) => [...chatKeys.all, 'channel', id] as const,
  messages: (channelId: string) => [...chatKeys.all, 'messages', channelId] as const,
  session: (id: string) => [...chatKeys.all, 'session', id] as const,
  notifications: () => [...chatKeys.all, 'notifications'] as const,
}

// api/chat.ts — API functions that return data
export async function fetchChannels(companyId: string): Promise<Channel[]> {
  const res = await fetch(`/api/channels?companyId=${companyId}`)
  if (!res.ok) throw new Error('Failed to fetch channels')
  return res.json()
}

// In component — useQuery hook
const { data: channels } = useQuery({
  queryKey: chatKeys.channels(),
  queryFn: () => fetchChannels(companyId),
})
```

Rules:
- **Query key factories** in `lib/queryKeys.ts` — never inline key arrays
- **API functions** in `api/` directory — never fetch directly in components
- **Mutations** use `useMutation` with `onSuccess` that invalidates the relevant query key
- **Optimistic updates** for message sending (show immediately, confirm on server response)
- **No Redux, no Zustand, no Context for server state** — React Query handles it all

### 5.2 WebSocket hooks

Paperclip's `useLiveRunTranscripts` hook pattern:

```typescript
// hooks/useChatWebSocket.ts
export function useChatWebSocket(sessionId: string) {
  const queryClient = useQueryClient()

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/chat/ws`)

    ws.onmessage = (event) => {
      const envelope: WsEnvelope = JSON.parse(event.data)

      switch (envelope.type) {
        case CHAT_EVENT_TYPES.CHAT_MESSAGE:
          // Append to React Query cache — no refetch needed
          queryClient.setQueryData(
            chatKeys.messages(envelope.payload.channelId),
            (old: Turn[]) => [...(old ?? []), envelope.payload.turn]
          )
          break
        case CHAT_EVENT_TYPES.CHAT_MESSAGE_STREAM:
          // Update streaming state for the current message
          break
        // ... handle other events
      }
    }

    return () => ws.close()
  }, [sessionId, queryClient])
}
```

Rules:
- **WS updates write directly to React Query cache** — this is how Paperclip does live updates
- **No separate state store for WS data** — React Query is the single source of truth
- **Reconnect logic**: Exponential backoff, replay from last_seq on reconnect

### 5.3 Component structure

```typescript
// components/ChatThread.tsx
import { useQuery } from '@tanstack/react-query'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { chatKeys } from '@/lib/queryKeys'
import { fetchMessages } from '@/api/chat'
import { useChatWebSocket } from '@/hooks/useChatWebSocket'

interface ChatThreadProps {
  channelId: string
  sessionId: string
}

export function ChatThread({ channelId, sessionId }: ChatThreadProps) {
  const { data: messages, isLoading } = useQuery({
    queryKey: chatKeys.messages(channelId),
    queryFn: () => fetchMessages(channelId),
  })

  useChatWebSocket(sessionId)

  if (isLoading) return <ChatThreadSkeleton />

  return (
    <ScrollArea className="flex-1">
      <div className="space-y-2 p-4">
        {messages?.map((turn) => (
          <MessageRow key={turn.id} turn={turn} />
        ))}
      </div>
    </ScrollArea>
  )
}
```

Rules:
- **Props interface** defined above the component, never inline
- **Named exports** — not default exports (Paperclip convention)
- **`cn()` for all class merging** — import from `@/lib/utils`
- **Skeleton loading** — use shadcn Skeleton for loading states
- **Destructure props** in the function signature

---

## 6. Auth patterns

### Server-side middleware

```typescript
// auth/validateHuman.ts
import type { Request, Response, NextFunction } from 'express'

export async function validateHuman(req: Request, res: Response, next: NextFunction) {
  const sessionCookie = req.cookies['paperclip-session']
  if (!sessionCookie) return res.status(401).json({ error: 'Not authenticated' })

  const session = await paperclipApi.validateSession(sessionCookie)
  if (!session) return res.status(401).json({ error: 'Invalid session' })

  req.userId = session.userId
  req.companyId = session.companyId
  next()
}

// auth/validateAgent.ts
export async function validateAgent(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' })

  const token = authHeader.slice(7)

  // Try CHAT_API_TOKEN first (chat-server-issued)
  const chatClaims = verifyChatToken(token)
  if (chatClaims) {
    req.agentId = chatClaims.agentId
    req.sessionId = chatClaims.sessionId
    return next()
  }

  // Fall back to PAPERCLIP_API_KEY (run-scoped JWT)
  const paperclipClaims = await paperclipApi.validateAgentJwt(token)
  if (paperclipClaims) {
    req.agentId = paperclipClaims.agentId
    req.companyId = paperclipClaims.companyId
    return next()
  }

  return res.status(401).json({ error: 'Invalid token' })
}
```

---

## 7. Testing

Paperclip uses Vitest (see `vitest.config.ts` at both `ui/` and server level).

```typescript
// __tests__/debounce.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DebounceBuffer } from '../session/Debounce'

describe('DebounceBuffer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('batches rapid messages into one flush', async () => {
    const onFlush = vi.fn()
    const buffer = new DebounceBuffer({ coalesceMs: 800, onFlush })

    buffer.enqueue('agent-1', turn1)
    buffer.enqueue('agent-1', turn2)
    buffer.enqueue('agent-1', turn3)

    vi.advanceTimersByTime(800)

    expect(onFlush).toHaveBeenCalledTimes(1)
    expect(onFlush).toHaveBeenCalledWith('agent-1', [turn1, turn2, turn3])
  })
})
```

Rules:
- **Vitest, not Jest** — Paperclip uses Vitest
- **Colocated tests** in `__tests__/` directories
- **`vi.fn()` for mocks**, `vi.useFakeTimers()` for time-dependent tests
- **Test file naming**: `*.test.ts` / `*.test.tsx`
- **Run**: `pnpm test:run` (single run), `pnpm test` (watch mode)

---

## 8. Process management — subprocess spawn rules

This is the most critical section. Read v6 handoff §5 alongside this.

```typescript
// subprocess/SubprocessManager.ts

// Rule 1: NEVER spawn while Paperclip heartbeat is running
// Rule 2: Chat sessions use ~/.claude/chat-sessions/{sessionId}/ — NEVER Paperclip's session namespace
// Rule 3: One subprocess per agent at a time, across ALL channels

import { spawn, ChildProcess } from 'child_process'

class SubprocessManager {
  // Global lock — one active spawn per agent
  private spawnLocks = new Map<string, Promise<void>>()

  async spawnCli(agentId: string, args: string[], env: Record<string, string>, cwd: string): Promise<SpawnResult> {
    // Queue behind any in-flight spawn for this agent
    const existing = this.spawnLocks.get(agentId)
    if (existing) await existing

    const run = this._doSpawn(agentId, args, env, cwd)
    this.spawnLocks.set(agentId, run.then(() => {}))

    try {
      return await run
    } finally {
      this.spawnLocks.delete(agentId)
    }
  }

  private async _doSpawn(agentId: string, args: string[], env: Record<string, string>, cwd: string): Promise<SpawnResult> {
    const proc = spawn(args[0], args.slice(1), {
      cwd,
      env: {
        ...process.env,
        ...env,
        // CRITICAL: Set these for the agent's SKILL.md to reference
        CHAT_API_URL: process.env.CHAT_API_URL,
        CHAT_SESSION_ID: env.CHAT_SESSION_ID,
        CHAT_API_TOKEN: env.CHAT_API_TOKEN,
        PAPERCLIP_WAKE_REASON: 'chat_message',
        PAPERCLIP_WAKE_COMMENT_ID: env.turnId,
      },
    })

    // Stream stdout to WS as chat.message.stream events
    // On exit: extract cli_session_id, persist, record token delta
    // ...
  }
}
```

### CLI session ID extraction

Paperclip adapters each have `extractSessionId` logic. Chat must do the same, per adapter:

- **claude_local**: Parse `--resume` session ID from stdout JSON stream. Store as `cli_session_id` in `agent_channel_states`.
- **codex_local**: Similar pattern but different output format.

### Workspace resolution

```typescript
// subprocess/WorkspaceResolver.ts
function resolveChatWorkspace(channel: Channel, agentId: string): { cwd: string } {
  const agentHome = `~/.paperclip/agents/${agentId}/workspace`

  switch (channel.type) {
    case 'dm':
    case 'company_general':
      return { cwd: agentHome }  // No project context needed

    case 'project':
      const pw = await paperclipApi.getProjectWorkspace(channel.paperclipRefId)
      return { cwd: pw?.cwd ?? agentHome }

    case 'task_thread':
      const issue = await paperclipApi.getIssue(channel.paperclipRefId)
      const issuePw = issue?.projectId
        ? await paperclipApi.getProjectWorkspace(issue.projectId)
        : null
      return { cwd: issuePw?.cwd ?? agentHome }
  }
}
```

---

## 9. Error handling rules

From v6 handoff §8.4 — implement these exactly:

| Failure | Behavior | Recovery |
|---------|----------|----------|
| CLI subprocess OOMs / non-zero exit | Log, emit `agent.error` WS event, release spawn lock | Surface "Agent encountered an error" to user. No auto-retry. |
| Paperclip API 5xx | Retry: 1s, 2s, 4s (3 attempts max) | After 3 failures: surface error in channel, mark session degraded |
| POST /api/costs fails | Log and continue — **non-blocking** | Retry once after 5s. If still failing, drop and emit warning metric |
| Background chunker fails | Mark chunk `dirty=true`. Continue without chunk. | Retry at next T_window boundary. Injection packet uses longer verbatim tail as fallback. |
| Global summary fold fails | Keep prior summary. Log. | Retry on next chunk. Crystallize falls back to last good summary. |
| WS disconnect during streaming | Client reconnects, sends `last_seq` | WS hub replays events since `last_seq` from turns table |

---

## 10. Environment variables

```bash
# Required
CHAT_SERVICE_KEY=           # Long-lived key for chat-server → Paperclip API calls
PAPERCLIP_API_URL=          # e.g., http://localhost:3100
CHAT_API_URL=               # e.g., http://localhost:4000 (chat-server's own URL)
DATABASE_URL=               # PostgreSQL connection string

# Optional
COALESCE_MS=800             # Debounce window override
T_WINDOW=1200               # Chunk window token target override
CHAT_TOKEN_SECRET=          # JWT signing secret for CHAT_API_TOKEN (auto-generated if missing)
```

Rules:
- **Never commit secrets to source control**
- **CHAT_SERVICE_KEY** is rotated manually, stored only in env
- **X-Paperclip-Run-Id** headers use synthetic run IDs: `chat-server-{uuid}`

---

## 11. Git conventions

Follow Paperclip's contributor conventions:

- **Branch naming**: `feature/chat-session-manager`, `fix/debounce-race-condition`
- **Commit messages**: Conventional commits — `feat: add wakeup coalescing`, `fix: spawn lock race on concurrent mentions`
- **PR scope**: One concern per PR. "Add SubprocessManager with spawn lock" is one PR. "Add entire group chat context" may be 2-3 PRs.
- **Typecheck before commit**: `pnpm typecheck` must pass
- **Tests before commit**: `pnpm test:run` must pass

---

## 12. Key invariants — print these on a wall

From v6 handoff. Every line of code must respect these:

1. **Never spawn while `agent.status=running`** — chat queues behind Paperclip heartbeats
2. **Chat sessions in `~/.claude/chat-sessions/`** — never Paperclip's session namespace
3. **Per-agent global spawn lock** across all channels
4. **Wakeup = `automation/issue_comment_mentioned`** — any other value resets Claude Code sessions
5. **`CHAT_SERVICE_KEY` for all service→Paperclip calls** — long-lived, env var only
6. **Token counts = js-tiktoken at write time, delta not cumulative** — never repeat the billion-token mistake
7. **Background LLM costs POST to `/api/costs`** — non-blocking on failure

---

*paperclip-chat coding guidelines · derived from paperclipai/paperclip codebase (v0.3.0+) and handoff v6*
