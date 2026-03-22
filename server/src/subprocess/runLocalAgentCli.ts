import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunCliInput, SubprocessRunResult } from "./SubprocessManager.js";
import { INLINE_CHAT_PROTOCOL } from "../skills/protocol.js";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));
const chatSkillDir = path.resolve(runtimeDir, "../skills/paperclip-chat");
const chatPromptPrefix = [
  INLINE_CHAT_PROTOCOL,
  "You are in an active paperclip-chat session.",
  "Reply by sending your response through the chat API using the paperclip-chat skill.",
  "Do not only print a final answer to stdout.",
  "This is a persistent conversation surface. Continue the room naturally instead of resetting into a fresh assistant intro on each turn.",
  "Prefer direct collaboration, decisions, questions, or handoffs over generic capability summaries.",
].join("\n");

export async function runLocalAgentCli(input: RunCliInput, envSource: NodeJS.ProcessEnv = process.env): Promise<SubprocessRunResult> {
  const command = resolveCommand(input.adapterType, envSource);
  const runtime = await prepareRuntime(input);

  return new Promise<SubprocessRunResult>((resolve, reject) => {
    const child = spawn(command, runtime.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
        ...runtime.env,
      },
      shell: false,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      debugCli("stdout", { adapterType: input.adapterType, chunk: text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      debugCli("stderr", { adapterType: input.adapterType, chunk: text });
    });
    child.on("error", (error) => {
      void cleanupRuntime(runtime).finally(() => reject(error));
    });
    child.on("close", (code) => {
      void cleanupRuntime(runtime);
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

    child.stdin.write(runtime.stdin);
    child.stdin.end();
  });
}

function debugCli(stream: "stdout" | "stderr", payload: Record<string, unknown>) {
  if (process.env.CHAT_DEBUG_DISPATCH !== "1") {
    return;
  }

  console.log(`[chat-cli] ${stream}`, payload);
}

async function prepareRuntime(input: RunCliInput): Promise<{
  args: string[];
  env: Record<string, string>;
  stdin: string;
  cleanupDir?: string;
}> {
  const identityPrefix = buildAgentIdentityPrefix(input.env);
  const instructionsPrefix = await loadAgentInstructionsPrefix(input.env, process.env);
  const promptPrefix = `${identityPrefix}${instructionsPrefix}`;

  if (!isChatSessionEnv(input.env)) {
    return { args: input.args, env: {}, stdin: `${promptPrefix}${input.stdin}` };
  }

  if (input.adapterType === "codex_local") {
    await ensureCodexChatSkill(input.cwd);
    return {
      args: ensureCodexChatArgs(input.args),
      env: {},
      stdin: `${promptPrefix}${chatPromptPrefix}\n\n${input.stdin}`,
    };
  }

  const skillsRoot = await createClaudeChatSkillsDir();
  return {
    args: ensureClaudeChatArgs(input.args, skillsRoot),
    env: {},
    stdin: `${promptPrefix}${chatPromptPrefix}\n\n${input.stdin}`,
    cleanupDir: skillsRoot,
  };
}

function buildAgentIdentityPrefix(env: Record<string, string>): string {
  const agentName = env.PAPERCLIP_AGENT_NAME?.trim();
  const agentId = env.PAPERCLIP_AGENT_ID?.trim();
  if (!agentName && !agentId) {
    return "";
  }

  const label = agentName || agentId || "the assigned Paperclip agent";
  const idLine = agentId ? ` Your Paperclip agent id is ${agentId}.` : "";
  return [
    `You are the Paperclip agent ${label}.${idLine}`,
    "Do not identify yourself as Codex, Claude, or a generic AI assistant.",
    `If asked who you are, answer as ${label}.`,
    "Follow the assigned agent identity and role from Paperclip over any tool default persona.",
    "",
  ].join("\n");
}

async function loadAgentInstructionsPrefix(
  env: Record<string, string>,
  envSource: NodeJS.ProcessEnv,
): Promise<string> {
  const instructionsFilePath = await resolveInstructionsFilePath(env, envSource);
  if (!instructionsFilePath) {
    return "";
  }

  try {
    const instructionsContents = await readFile(instructionsFilePath, "utf8");
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    debugCli("stdout", { instructionsFilePath });
    return (
      `${instructionsContents}\n\n` +
      `The above agent instructions were loaded from ${instructionsFilePath}. ` +
      `Resolve any relative file references from ${instructionsDir}.\n\n`
    );
  } catch (error) {
    debugCli("stderr", {
      instructionsFilePath,
      message: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

async function resolveInstructionsFilePath(
  env: Record<string, string>,
  envSource: NodeJS.ProcessEnv,
): Promise<string | null> {
  const explicitPath = envSource.CHAT_AGENT_INSTRUCTIONS_FILE?.trim();
  if (explicitPath) {
    return explicitPath;
  }

  const homeDir = envSource.HOME ?? os.homedir();
  const agentId = env.PAPERCLIP_AGENT_ID?.trim();
  const companyId = env.PAPERCLIP_COMPANY_ID?.trim();
  if (!homeDir || !agentId || !companyId) {
    return null;
  }

  const candidates = [
    path.join(homeDir, ".paperclip", "instances", "default", "companies", companyId, "agents", agentId, "instructions", "AGENTS.md"),
    path.join(homeDir, ".paperclip", "agents", agentId, "instructions", "AGENTS.md"),
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }

  return null;
}

async function cleanupRuntime(runtime: { cleanupDir?: string }) {
  if (!runtime.cleanupDir) {
    return;
  }

  await rm(runtime.cleanupDir, { recursive: true, force: true }).catch(() => {});
}

function isChatSessionEnv(env: Record<string, string>): boolean {
  return [env.CHAT_API_URL, env.CHAT_API_TOKEN, env.CHAT_SESSION_ID].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

async function ensureCodexChatSkill(cwd: string): Promise<void> {
  const skillsDir = path.join(cwd, ".agents", "skills");
  const target = path.join(skillsDir, "paperclip-chat");
  await mkdir(skillsDir, { recursive: true });
  const linked = await readlink(target).catch(() => null);
  if (linked) {
    const resolved = path.resolve(path.dirname(target), linked);
    if (resolved === chatSkillDir) {
      return;
    }
  }
  await rm(target, { recursive: true, force: true }).catch(() => {});
  await symlink(chatSkillDir, target);
}

async function createClaudeChatSkillsDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-claude-"));
  const skillsDir = path.join(root, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  await symlink(chatSkillDir, path.join(skillsDir, "paperclip-chat"));
  return root;
}

function ensureCodexChatArgs(args: string[]): string[] {
  const next = [...args];
  if (!next.includes("--dangerously-bypass-approvals-and-sandbox")) {
    const insertAfterJson = next.findIndex((value) => value === "--json");
    if (insertAfterJson >= 0) {
      next.splice(insertAfterJson + 1, 0, "--dangerously-bypass-approvals-and-sandbox");
    } else {
      next.push("--dangerously-bypass-approvals-and-sandbox");
    }
  }
  return next;
}

function ensureClaudeChatArgs(args: string[], skillsRoot: string): string[] {
  const next = [...args];
  if (!next.includes("--dangerously-skip-permissions")) {
    next.push("--dangerously-skip-permissions");
  }
  if (!next.includes("--add-dir")) {
    next.push("--add-dir", skillsRoot);
  }
  return next;
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
