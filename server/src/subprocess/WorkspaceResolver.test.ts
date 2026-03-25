import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "@paperclip-chat/shared";
import { resolveChatWorkspace } from "./WorkspaceResolver.js";

const baseChannel: Channel = {
  id: "channel-1",
  type: "dm",
  companyId: "company-1",
  paperclipRefId: null,
  name: "DM",
};

describe("resolveChatWorkspace", () => {
  it("uses agent home for dm channels", async () => {
    const result = await resolveChatWorkspace(
      baseChannel,
      "agent-1",
      "session-1",
      mockPaperclipClient(),
    );

    expect(result.cwd).toBe(path.join(os.homedir(), ".paperclip", "agents", "agent-1", "workspace"));
    expect(result.sessionPath).toBe(path.join(os.homedir(), ".claude", "chat-sessions", "session-1"));
  });

  it("prefers the Paperclip-managed workspace layout when it exists", async () => {
    const agentId = "8c180a4d-a7ac-4a0f-8739-c572b3f60215";
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-resolver-"));
    const managedWorkspace = path.join(root, ".paperclip", "instances", "default", "workspaces", agentId);
    await mkdir(managedWorkspace, { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const result = await resolveChatWorkspace(baseChannel, agentId, "session-1", mockPaperclipClient());
      expect(result.cwd).toBe(managedWorkspace);
    } finally {
      process.env.HOME = origHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses project workspace when available", async () => {
    const result = await resolveChatWorkspace(
      { ...baseChannel, type: "project", paperclipRefId: "project-1" },
      "agent-1",
      "session-1",
      mockPaperclipClient({
        getProjectWorkspace: vi.fn().mockResolvedValue({ workspaceDir: "/tmp/project-workspace" }),
      }),
    );

    expect(result.cwd).toBe("/tmp/project-workspace");
  });

  it("falls back to agent home when project workspace is missing", async () => {
    const result = await resolveChatWorkspace(
      { ...baseChannel, type: "project", paperclipRefId: "project-1" },
      "agent-1",
      "session-1",
      mockPaperclipClient({
        getProjectWorkspace: vi.fn().mockResolvedValue({ workspaceDir: null, path: null }),
      }),
    );

    expect(result.cwd).toBe(path.join(os.homedir(), ".paperclip", "agents", "agent-1", "workspace"));
  });

  it("uses issue project workspace for task threads", async () => {
    const client = mockPaperclipClient({
      getIssue: vi.fn().mockResolvedValue({ id: "issue-1", projectId: "project-9" }),
      getProjectWorkspace: vi.fn().mockResolvedValue({ workspaceDir: "/tmp/project-9" }),
    });

    const result = await resolveChatWorkspace(
      { ...baseChannel, type: "task_thread", paperclipRefId: "issue-1" },
      "agent-1",
      "session-1",
      client,
    );

    expect(result.cwd).toBe("/tmp/project-9");
  });

  it("never uses the Paperclip project session namespace for chat sessions", async () => {
    const result = await resolveChatWorkspace(
      baseChannel,
      "agent-1",
      "session-1",
      mockPaperclipClient(),
    );

    expect(result.sessionPath).not.toContain(`${path.sep}.claude${path.sep}projects${path.sep}`);
    expect(result.sessionPath).toContain(`${path.sep}.claude${path.sep}chat-sessions${path.sep}`);
  });
});

function mockPaperclipClient(overrides: Partial<{
  getProjectWorkspace: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    getProjectWorkspace: overrides.getProjectWorkspace ?? vi.fn().mockResolvedValue({ workspaceDir: null, path: null }),
    getIssue: overrides.getIssue ?? vi.fn().mockResolvedValue({ id: "issue-1", projectId: null }),
  };
}
