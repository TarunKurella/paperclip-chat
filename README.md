# Paperclip Chat

[![Build](https://img.shields.io/github/actions/workflow/status/TarunKurella/paperclip-chat/ci.yml?branch=main&label=build&logo=github)](https://github.com/TarunKurella/paperclip-chat/actions)
[![Tests](https://img.shields.io/github/actions/workflow/status/TarunKurella/paperclip-chat/test.yml?branch=main&label=tests)](https://github.com/TarunKurella/paperclip-chat/actions)
[![License](https://img.shields.io/github/license/TarunKurella/paperclip-chat)](https://github.com/TarunKurella/paperclip-chat/blob/main/LICENSE)

## Purpose

Paperclip Chat is an agent-native, multi-agent chat surface that mirrors Paperclip's collaboration model. It keeps a single shared room while tracking per-agent context, naming, and handoffs so agents can collaborate naturally without bursting the live context window.

## Features

- **Agent-native prompts:** identity-first prompts ensure each agent identifies as itself (`tester`, `eagle`, etc.) instead of a generic assistant.
- **Mention-aware dispatch:** Delivers agent-to-agent `@handle` requests reliably, even when the originating message comes from another agent.
- **Crystallize checkpoints:** Sessions stay live after crystallize, with checkpoints, previews, and Paperclip issue exports.
- **Rolling context trimming:** Agents watch the shared room but only consume context relevant to their anchor and checkpoint, keeping LLM costs stable.
- **Human-friendly UI:** Sidebar, thread, notifications, and header state stay synced with the data-plane and WebSocket stream.

## Architecture

1. **Server (`@paperclip-chat/server`)**: Express API, Drizzle-based data layer, WebSocket hub, subprocess management for `codex_local`/`claude_local`, presence & summary orchestration.
2. **UI (`@paperclip-chat/ui`)**: React + tailwind interface with custom components for the sidebar, thread, summary bar, and notifications.
3. **Shared (`@paperclip-chat/shared`)**: API paths, Zod schemas, constants, and TypeScript types.
4. **Agents**: Skill + protocol prompts live under `server/src/skills`, with `paperclip-chat` skill embedded into every local runtime.

Read the code comments for prompt details and use `cliSummarizer.ts` for preview/inference flows.

## Getting Started

```bash
git clone https://github.com/TarunKurella/paperclip-chat.git
pm install # pnpm preferred with workspace
```

### Dev Server

```
pnpm dev
```

Runs orchestrator, server, and UI concurrently. Environment variables:
- `PAPERCLIP_API_URL` (Paperclip backend)
- `CHAT_SERVICE_KEY` (shared secret)
- `CHAT_LOCAL_DEV_AUTH=true` for local cookies
- `PORT=4000` to bind the chat server

### Running Tests

```
pnpm --filter @paperclip-chat/server test
pnpm --filter @paperclip-chat/ui test
```

### Database

```
pnpm --filter @paperclip-chat/db db:migrate
```

## What to Watch

- `server/src/subprocess/runLocalAgentCli.ts` loads agent instructions + overrides identity.
- `server/src/session/SessionManager.ts` handles mention parsing & crystallize checkpoints.
- `ui/src/App.tsx` keeps UI state and label `seq` in sync with live turns.
- `packages/db/drizzle/0002_chat_crystallize_checkpoint.sql` adds schema for `last_crystallized_seq`.

## Contributing

1. Claim work using `bd ready`, then `bd update <id> --claim`.
2. Follow the current prompt/policy guidance in `server/src/skills`.
3. Run the matching tests before pushing.
4. `git push origin main` once clean.

## License

MIT
