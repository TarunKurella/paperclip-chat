import { runLocalAgentCli } from "../subprocess/runLocalAgentCli.js";

export async function summarizeChunkWithCli(
  turns: Array<{ fromParticipantId: string; content: string }>,
  envSource: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const prompt = [
    "Summarize this chat segment for future agent context injection.",
    "Keep only durable facts, decisions, blockers, owners, and unresolved questions.",
    "Drop filler, greetings, and generic assistant phrasing.",
    "Write as compact room memory, not as prose for an end user.",
    "",
    ...turns.map((turn) => `${turn.fromParticipantId}: ${turn.content}`),
  ].join("\n");

  const result = await runLocalAgentCli(
    {
      adapterType: envSource.CHAT_SUMMARY_ADAPTER?.trim() || "claude_local",
      cwd: process.cwd(),
      args: (envSource.CHAT_SUMMARY_ADAPTER?.trim() || "claude_local") === "codex_local"
        ? ["exec", "--json", "-"]
        : ["--print", "-", "--output-format", "stream-json", "--verbose"],
      env: {},
      stdin: prompt,
    },
    envSource,
  );

  return result.stream?.map((event) => event.delta).join("").trim() || "";
}

export async function summarizeFoldWithCli(
  previousSummary: string,
  chunkSummary: string,
  tokenBudget: number,
  envSource: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const prompt = [
    "Update this rolling room-memory summary.",
    `Keep the result under roughly ${tokenBudget} tokens.`,
    "Preserve only what future agents need in order to continue the conversation intelligently.",
    "Prefer bullets or dense short paragraphs over narration.",
    "",
    "[Previous summary]",
    previousSummary || "(none)",
    "",
    "[New chunk summary]",
    chunkSummary,
  ].join("\n");

  const result = await runLocalAgentCli(
    {
      adapterType: envSource.CHAT_SUMMARY_ADAPTER?.trim() || "claude_local",
      cwd: process.cwd(),
      args: (envSource.CHAT_SUMMARY_ADAPTER?.trim() || "claude_local") === "codex_local"
        ? ["exec", "--json", "-"]
        : ["--print", "-", "--output-format", "stream-json", "--verbose"],
      env: {},
      stdin: prompt,
    },
    envSource,
  );

  return result.stream?.map((event) => event.delta).join("").trim() || chunkSummary;
}

export async function summarizeCrystallizePreviewWithCli(
  turns: Array<{ fromParticipantId: string; content: string }>,
  envSource: NodeJS.ProcessEnv = process.env,
): Promise<{ summaryText: string | null; decisionText: string | null }> {
  const prompt = [
    "Generate a crystallize preview for this agent-native chat.",
    "Return exactly these sections:",
    "[SUMMARY]",
    "[DECISION]",
    "SUMMARY: concise issue handoff summary in 2-4 sentences with the current ask, key context, and likely next action.",
    "DECISION: most likely current conclusion, recommendation, or next-step. If none, write NONE.",
    "Be concrete. Avoid generic assistant framing and avoid repeating greetings or social filler.",
    "",
    ...turns.map((turn) => `${turn.fromParticipantId}: ${turn.content}`),
  ].join("\n");

  const result = await runLocalAgentCli(
    {
      adapterType: envSource.CHAT_SUMMARY_ADAPTER?.trim() || "claude_local",
      cwd: process.cwd(),
      args: (envSource.CHAT_SUMMARY_ADAPTER?.trim() || "claude_local") === "codex_local"
        ? ["exec", "--json", "-"]
        : ["--print", "-", "--output-format", "stream-json", "--verbose"],
      env: {},
      stdin: prompt,
    },
    envSource,
  );

  const text = result.stream?.map((event) => event.delta).join("").trim() || "";
  const summaryText = text.match(/\[SUMMARY\]\s*([\s\S]*?)(?=\[DECISION\]|$)/i)?.[1]?.trim() || null;
  const decisionRaw = text.match(/\[DECISION\]\s*([\s\S]*?)$/i)?.[1]?.trim() || null;

  return {
    summaryText,
    decisionText: decisionRaw && decisionRaw.toUpperCase() !== "NONE" ? decisionRaw : null,
  };
}
