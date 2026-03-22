import { runLocalAgentCli } from "../subprocess/runLocalAgentCli.js";

export async function summarizeChunkWithCli(
  turns: Array<{ fromParticipantId: string; content: string }>,
  envSource: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const prompt = [
    "Summarize this conversation segment for future context injection.",
    "Keep concrete facts, decisions, blockers, and unresolved questions.",
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
    "Update this rolling conversation summary.",
    `Keep the result under roughly ${tokenBudget} tokens.`,
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
