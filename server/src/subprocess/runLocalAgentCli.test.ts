import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLocalAgentCli } from "./runLocalAgentCli.js";

const tempDirs: string[] = [];

describe("runLocalAgentCli", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("injects the paperclip-chat skill and bypass flags for codex chat runs", async () => {
    const fixture = await createFixture("codex");
    const result = await runLocalAgentCli(
      {
        adapterType: "codex_local",
        cwd: fixture.workspaceDir,
        args: ["exec", "--json", "-"],
        env: {
          CHAT_API_URL: "http://127.0.0.1:4000",
          CHAT_API_TOKEN: "token",
          CHAT_SESSION_ID: "session-1",
          TEST_CAPTURE_ARGS: fixture.argsPath,
          TEST_CAPTURE_STDIN: fixture.stdinPath,
        },
        stdin: "How are you?",
      },
      {
        ...process.env,
        CHAT_CODEX_COMMAND: fixture.commandPath,
      },
    );

    expect(result.stream).toEqual([{ type: "delta", delta: "hello from codex" }]);
    expect(await readFile(fixture.argsPath, "utf8")).toContain("--dangerously-bypass-approvals-and-sandbox");
    const stdin = await readFile(fixture.stdinPath, "utf8");
    expect(stdin).toContain("paperclip-chat protocol:");
    expect(stdin).toContain("Reply by sending your response through the chat API");
    expect(stdin).toContain("How are you?");
    const skillPath = path.join(fixture.workspaceDir, ".agents", "skills", "paperclip-chat");
    expect((await lstat(skillPath)).isSymbolicLink()).toBe(true);
  });

  it("injects the paperclip-chat skill dir and permission flags for claude chat runs", async () => {
    const fixture = await createFixture("claude");
    const result = await runLocalAgentCli(
      {
        adapterType: "claude_local",
        cwd: fixture.workspaceDir,
        args: ["--print", "-", "--output-format", "stream-json", "--verbose"],
        env: {
          CHAT_API_URL: "http://127.0.0.1:4000",
          CHAT_API_TOKEN: "token",
          CHAT_SESSION_ID: "session-1",
          TEST_CAPTURE_ARGS: fixture.argsPath,
          TEST_CAPTURE_STDIN: fixture.stdinPath,
        },
        stdin: "How are you?",
      },
      {
        ...process.env,
        CHAT_CLAUDE_COMMAND: fixture.commandPath,
      },
    );

    expect(result.stream).toEqual([{ type: "delta", delta: "hello from claude" }]);
    const args = await readFile(fixture.argsPath, "utf8");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--add-dir");
    const stdin = await readFile(fixture.stdinPath, "utf8");
    expect(stdin).toContain("paperclip-chat protocol:");
    expect(stdin).toContain("How are you?");
  });
});

async function createFixture(kind: "codex" | "claude") {
  const root = await mkdtemp(path.join(os.tmpdir(), `paperclip-chat-${kind}-`));
  tempDirs.push(root);
  const workspaceDir = path.join(root, "workspace");
  const argsPath = path.join(root, "args.txt");
  const stdinPath = path.join(root, "stdin.txt");
  await writeFile(path.join(root, "placeholder"), "", "utf8");
  await writeFile(
    path.join(root, `${kind}.sh`),
    buildScript(kind),
    "utf8",
  );
  const commandPath = path.join(root, `${kind}.sh`);
  await chmod(commandPath, 0o755);
  await rm(path.join(root, "placeholder"), { force: true });
  await writeFile(argsPath, "", "utf8");
  await writeFile(stdinPath, "", "utf8");
  await mkdir(workspaceDir, { recursive: true });

  return {
    root,
    workspaceDir,
    commandPath,
    argsPath,
    stdinPath,
  };
}

function buildScript(kind: "codex" | "claude"): string {
  const output = kind === "codex"
    ? [
        `printf '%s\\n' '{"type":"thread.started","thread_id":"cli-1"}'`,
        `printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}'`,
        `printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":5}}'`,
      ].join("\n")
    : [
        `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"claude-1"}'`,
        `printf '%s\\n' '{"type":"assistant","session_id":"claude-1","message":{"content":[{"type":"text","text":"hello from claude"}]}}'`,
        `printf '%s\\n' '{"type":"result","session_id":"claude-1","result":"hello from claude","usage":{"input_tokens":2,"output_tokens":4}}'`,
      ].join("\n");

  return `#!/bin/sh
printf '%s ' "$@" > "$TEST_CAPTURE_ARGS"
cat > "$TEST_CAPTURE_STDIN"
${output}
`;
}
