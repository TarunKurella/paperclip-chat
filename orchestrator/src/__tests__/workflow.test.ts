import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkflowError,
  loadWorkflowDefinition,
  resolveWorkflowConfig,
  type WorkflowDefinition,
} from "../orchestrator/workflow.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadWorkflowDefinition", () => {
  it("loads front matter and trims prompt body", async () => {
    const cwd = await makeTempWorkflow(
      "---\nbeads:\n  command: bd\npolling:\n  interval_ms: 1000\n---\n\nPrompt body\n",
    );

    const workflow = await loadWorkflowDefinition({ cwd });

    expect(workflow.config).toMatchObject({
      beads: { command: "bd" },
      polling: { interval_ms: 1000 },
    });
    expect(workflow.promptTemplate).toBe("Prompt body");
  });

  it("treats files without front matter as prompt-only", async () => {
    const cwd = await makeTempWorkflow("plain prompt");

    const workflow = await loadWorkflowDefinition({ cwd });

    expect(workflow.config).toEqual({});
    expect(workflow.promptTemplate).toBe("plain prompt");
  });

  it("throws missing_workflow_file when absent", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-workflow-"));
    tempDirs.push(cwd);

    await expect(loadWorkflowDefinition({ cwd })).rejects.toMatchObject({
      code: "missing_workflow_file",
    });
  });

  it("throws workflow_parse_error on invalid yaml", async () => {
    const cwd = await makeTempWorkflow("---\nbeads: [\n---\nBody");

    await expect(loadWorkflowDefinition({ cwd })).rejects.toMatchObject({
      code: "workflow_parse_error",
    });
  });

  it("throws workflow_front_matter_not_a_map for scalar front matter", async () => {
    const cwd = await makeTempWorkflow("---\n- one\n- two\n---\nBody");

    await expect(loadWorkflowDefinition({ cwd })).rejects.toMatchObject({
      code: "workflow_front_matter_not_a_map",
    });
  });
});

describe("resolveWorkflowConfig", () => {
  it("applies defaults and expands path and env values", () => {
    const definition: WorkflowDefinition = {
      path: "/repo/WORKFLOW.md",
      promptTemplate: "prompt",
      config: {
        beads: {
          command: "$BD_COMMAND",
          db_path: "$BD_DB_PATH",
        },
        workspace: {
          root: "~/workspaces",
        },
        codex: {
          command: "codex app-server",
        },
      },
    };

    const resolved = resolveWorkflowConfig(definition, {
      cwd: "/repo",
      env: {
        BD_COMMAND: "bd",
        BD_DB_PATH: ".beads/state.db",
      },
    });

    expect(resolved.beads.command).toBe("bd");
    expect(resolved.beads.dbPath).toBe("/repo/.beads/state.db");
    expect(resolved.beads.readyArgs).toEqual(["ready", "--json"]);
    expect(resolved.workspace.root).toContain("workspaces");
    expect(resolved.agent.maxConcurrentAgents).toBe(10);
  });

  it("rejects empty required commands", () => {
    const definition: WorkflowDefinition = {
      path: "/repo/WORKFLOW.md",
      promptTemplate: "prompt",
      config: {
        beads: {
          command: "",
        },
        codex: {
          command: "",
        },
      },
    };

    expect(() => resolveWorkflowConfig(definition)).toThrowError(WorkflowError);
  });
});

async function makeTempWorkflow(contents: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-workflow-"));
  tempDirs.push(cwd);
  await writeFile(path.join(cwd, "WORKFLOW.md"), contents, "utf8");
  return cwd;
}
