import { spawn } from "node:child_process";
import type { RunCliInput, SubprocessRunResult } from "./SubprocessManager.js";

export async function runLocalAgentCli(input: RunCliInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SubprocessRunResult> {
  const command = resolveCommand(input.adapterType, envSource);

  return new Promise<SubprocessRunResult>((resolve, reject) => {
    const child = spawn(command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
      },
      shell: false,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 0) !== 0) {
        const message = stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? -1}`;
        reject(new Error(message));
        return;
      }

      const parsed = input.adapterType === "codex_local"
        ? parseCodexJsonl(stdout)
        : parseClaudeStreamJson(stdout);

      resolve({
        cliSessionId: parsed.sessionId,
        cliSessionPath: input.env.CHAT_SESSION_ID ? `${process.env.HOME ?? ""}/.claude/chat-sessions/${input.env.CHAT_SESSION_ID}` : null,
        actualInputTokens: parsed.actualInputTokens,
        outputTokens: parsed.outputTokens,
        stream: parsed.summary ? [{ type: "delta", delta: parsed.summary }] : [],
      });
    });

    child.stdin.write(input.stdin);
    child.stdin.end();
  });
}

function resolveCommand(adapterType: string, envSource: NodeJS.ProcessEnv): string {
  if (adapterType === "codex_local") {
    return envSource.CHAT_CODEX_COMMAND?.trim() || "codex";
  }

  return envSource.CHAT_CLAUDE_COMMAND?.trim() || "claude";
}

function parseClaudeStreamJson(stdout: string): {
  sessionId: string | null;
  summary: string;
  actualInputTokens: number;
  outputTokens: number;
} {
  let sessionId: string | null = null;
  let summary = "";
  let actualInputTokens = 0;
  let outputTokens = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const event = safeParseJson(line);
    if (!event) {
      continue;
    }

    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      sessionId = event.session_id;
      continue;
    }

    if (event.type === "assistant") {
      sessionId = typeof event.session_id === "string" ? event.session_id : sessionId;
      const message = isRecord(event.message) ? event.message : null;
      const content = Array.isArray(message?.content) ? message.content : [];
      const textBlocks = content
        .filter((entry): entry is Record<string, unknown> => isRecord(entry))
        .filter((entry) => entry.type === "text" && typeof entry.text === "string")
        .map((entry) => String(entry.text));
      if (textBlocks.length > 0) {
        summary = [summary, textBlocks.join("\n\n")].filter(Boolean).join("\n\n");
      }
      continue;
    }

    if (event.type === "result") {
      sessionId = typeof event.session_id === "string" ? event.session_id : sessionId;
      summary = typeof event.result === "string" && event.result.trim().length > 0 ? event.result.trim() : summary;
      const usage = isRecord(event.usage) ? event.usage : null;
      actualInputTokens = readNumber(usage?.input_tokens, actualInputTokens);
      outputTokens = readNumber(usage?.output_tokens, outputTokens);
    }
  }

  return { sessionId, summary: summary.trim(), actualInputTokens, outputTokens };
}

function parseCodexJsonl(stdout: string): {
  sessionId: string | null;
  summary: string;
  actualInputTokens: number;
  outputTokens: number;
} {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let actualInputTokens = 0;
  let outputTokens = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const event = safeParseJson(line);
    if (!event) {
      continue;
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
      continue;
    }

    if (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message" && typeof event.item.text === "string") {
      messages.push(event.item.text);
      continue;
    }

    if (event.type === "turn.completed" && isRecord(event.usage)) {
      actualInputTokens = readNumber(event.usage.input_tokens, actualInputTokens);
      outputTokens = readNumber(event.usage.output_tokens, outputTokens);
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    actualInputTokens,
    outputTokens,
  };
}

function safeParseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
