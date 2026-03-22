import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.join(skillsDir, "paperclip-chat", "SKILL.md");

export const INLINE_CHAT_PROTOCOL = [
  "paperclip-chat protocol:",
  "- Send chat turns to POST $CHAT_API_URL/api/sessions/$CHAT_SESSION_ID/send with Authorization: Bearer $CHAT_API_TOKEN.",
  "- Use [DECISION] at the start of a turn when you need the result surfaced as a decision.",
  "- Use chat for live coordination and issue comments for durable task history.",
  "- Discover channels with GET $CHAT_API_URL/api/channels.",
  "- Expect a 20 messages per minute per-agent rate limit.",
].join("\n");

export function readPaperclipChatSkill(): string {
  return readFileSync(skillPath, "utf8");
}
