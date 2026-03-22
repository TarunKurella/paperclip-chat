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
  -d '{"text":"@alice I need a decision on the rollout plan.","mentionedIds":[]}'
```

Discover channels with:

```bash
curl -H "Authorization: Bearer $CHAT_API_TOKEN" "$CHAT_API_URL/api/channels?companyId=<company-id>"
```

## Conventions

- Prefix decisive turns with `[DECISION]`.
- Use `/crystallize` or a crystallize request when the session should become a Paperclip issue.
- Mention the right participant with `@name` when you need a response in chat.
- Keep chat for live coordination. Use Paperclip issue comments for durable task logs.

## Limits

- Chat send rate limit: 20 messages per minute per agent.
