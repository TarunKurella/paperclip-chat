import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceManager, sanitizeWorkspaceKey } from "../orchestrator/workspace.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WorkspaceManager", () => {
  it("sanitizes identifiers and runs after_create on first creation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-workspaces-"));
    tempDirs.push(root);

    const manager = new WorkspaceManager(
      { root },
      {
        afterCreate: "printf created > .paperclip-created",
        timeoutMs: 5000,
      },
    );

    const workspace = await manager.createForBead("paperclip/chat:alpha");
    const marker = await readFile(path.join(workspace.path, ".paperclip-created"), "utf8");

    expect(workspace.workspaceKey).toBe("paperclip_chat_alpha");
    expect(marker).toBe("created");
  });

  it("treats before_run failure as fatal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-workspaces-"));
    tempDirs.push(root);

    const manager = new WorkspaceManager(
      { root },
      {
        beforeRun: "exit 2",
        timeoutMs: 5000,
      },
    );

    const workspace = await manager.createForBead("paperclip-chat-1");

    await expect(manager.runBeforeRun(workspace.path)).rejects.toThrow(/before_run/);
  });

  it("rehydrates stale reused workspaces before running after_create", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-workspaces-"));
    tempDirs.push(root);

    const workspacePath = path.join(root, "paperclip-chat-stale");
    await mkdir(path.join(workspacePath, ".beads"), { recursive: true });
    await mkdir(path.join(workspacePath, ".paperclip-artifacts"), { recursive: true });
    await writeFile(path.join(workspacePath, ".git"), "gitdir: /tmp/fake\n", "utf8");
    await writeFile(path.join(workspacePath, "AGENTS.md"), "# stale\n", "utf8");

    const manager = new WorkspaceManager(
      { root },
      {
        afterCreate: "printf rehydrated > .paperclip-created && printf ok > repo-marker",
        timeoutMs: 5000,
      },
    );

    const workspace = await manager.createForBead("paperclip-chat-stale");
    const marker = await readFile(path.join(workspace.path, ".paperclip-created"), "utf8");
    const repoMarker = await readFile(path.join(workspace.path, "repo-marker"), "utf8");

    expect(workspace.createdNow).toBe(true);
    expect(marker).toBe("rehydrated");
    expect(repoMarker).toBe("ok");
  });

  it("runs before_remove before replacing an invalid reused workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-chat-workspaces-"));
    tempDirs.push(root);

    const workspacePath = path.join(root, "paperclip-chat-stale");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, ".git"), "gitdir: /tmp/fake\n", "utf8");

    const manager = new WorkspaceManager(
      { root },
      {
        beforeRemove: "printf cleaned > ../cleanup-marker",
        afterCreate: "printf rehydrated > repo-marker",
        timeoutMs: 5000,
      },
    );

    await manager.createForBead("paperclip-chat-stale");

    const cleanupMarker = await readFile(path.join(root, "cleanup-marker"), "utf8");
    const repoMarker = await readFile(path.join(workspacePath, "repo-marker"), "utf8");

    expect(cleanupMarker).toBe("cleaned");
    expect(repoMarker).toBe("rehydrated");
  });
});

describe("sanitizeWorkspaceKey", () => {
  it("replaces unsupported characters", () => {
    expect(sanitizeWorkspaceKey("bead id/with spaces")).toBe("bead_id_with_spaces");
  });
});
