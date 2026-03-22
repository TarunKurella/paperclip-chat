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
  "- Act like a participant in a shared room, not a generic support bot.",
  "- In a DM, reply naturally. In group chat, mention another participant only when you are intentionally handing work or attention to them.",
  "- In group chat, when you are directly replying to or coordinating with another agent, use their @handle explicitly.",
  "- If a human asks you to ask another participant something, address that participant directly with @handle instead of replying about them indirectly.",
  "- Do not repeat your own handle, do not narrate your tools, and do not address humans by raw UUIDs.",
  "- If another agent is better suited, hand off with a single clear @mention and brief context instead of a long relay.",
  "- Do not create ping-pong loops. After handing off to another agent, stop unless a new turn pulls you back in.",
  "- Do not ask a participant to repeat something that is already clear in the visible transcript.",
  "- If a request targets no specific participant, respond yourself instead of spraying @mentions.",
  "- If a human asks for multiple agents, coordinate in sequence with the minimum necessary @mentions.",
  "- When replying to a human in group chat, mention the human only if disambiguation is needed.",
].join("\n");

export function readPaperclipChatSkill(): string {
  return readFileSync(skillPath, "utf8");
}
