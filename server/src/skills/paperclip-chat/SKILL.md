---
name: paperclip-chat
description: Use paperclip-chat to send live chat turns to humans or agents in an active session.
---

# paperclip-chat

Use `paperclip-chat` when you need to talk to humans or other agents in an active chat session. Use Paperclip issue comments when the work belongs on a durable task thread.

## Decision Table

| Situation | Use chat | Use issue comments |
| --- | --- | --- |
| Need quick clarification from a human | yes | no |
| Need to unblock a running task with a short status update | yes | no |
| Need to record durable task history on a specific Paperclip issue | no | yes |
| Need to escalate a final decision into tracked work | chat first, then crystallize | yes |
| Need to ask an agent or human for live collaboration | yes | no |

## Environment

- `CHAT_API_URL`: Base URL for the chat server
- `CHAT_SESSION_ID`: Current chat session id
- `CHAT_API_TOKEN`: Bearer token for chat requests

## Core Protocol

Send a chat turn with:

```bash
curl -X POST "$CHAT_API_URL/api/sessions/$CHAT_SESSION_ID/send" \
  -H "Authorization: Bearer $CHAT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"I need a decision on the rollout plan.","mentionedIds":[]}'
```

Discover channels with:

```bash
curl -H "Authorization: Bearer $CHAT_API_TOKEN" "$CHAT_API_URL/api/channels?companyId=<company-id>"
```

## Conventions

- Prefix decisive turns with `[DECISION]`.
- Use `/crystallize` or a crystallize request when the session should become a Paperclip issue.
- In a 1:1 DM, reply naturally. Do not prefix every reply with `@name`.
- Use `@name` only when you actually need to notify or disambiguate a participant in a multi-party chat.
- In a multi-agent room, if you are replying to another agent or asking them to act, use their `@name` explicitly.
- If a human tells you to ask another participant a question, ask that participant directly with `@name` instead of answering on their behalf.
- Behave like an agent participant in a shared room, not like a generic chatbot explaining its capabilities.
- Prefer acting on the latest ask over listing everything you can do.
- Keep turns conversational, specific, and short unless detail is clearly needed.
- Never address a human by a raw participant id. Use their visible name or omit the name.
- Do not ping yourself, and do not repeat another participant's `@name` unless you are intentionally handing them the floor.
- If another agent should take over, send one short handoff turn with the relevant context, then stop and let them respond.
- Avoid ping-pong loops. After handing work to another agent, do not jump back in unless a new turn clearly pulls you back.
- Do not ask for information that is already obvious from the visible room context.
- If the request is for you, answer it directly instead of routing it to someone else.
- If the human wants collaboration from several agents, coordinate with the fewest necessary `@mentions` in the clearest order.
- In group chat, mention a human only when needed for disambiguation or direct handoff.
- When sharing code, always use fenced Markdown code blocks such as ```java.
- When sharing short structured guidance, prefer Markdown bullets or short sections over plain text walls.
- Keep chat for live coordination. Use Paperclip issue comments for durable task logs.

## Limits

- Chat send rate limit: 20 messages per minute per agent.
