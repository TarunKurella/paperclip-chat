import os from "node:os";
import path from "node:path";
import type { Channel } from "@paperclip-chat/shared";
import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface WorkspaceResolution {
  cwd: string;
  sessionPath: string;
}

export async function resolveChatWorkspace(
  channel: Channel,
  agentId: string,
  sessionId: string,
  paperclipClient: Pick<PaperclipClient, "getProjectWorkspace" | "getIssue">,
): Promise<WorkspaceResolution> {
  const agentHome = path.join(os.homedir(), ".paperclip", "agents", agentId, "workspace");
  const sessionPath = path.join(os.homedir(), ".claude", "chat-sessions", sessionId);

  let cwd = agentHome;

  switch (channel.type) {
    case "project": {
      if (channel.paperclipRefId) {
        const workspace = await paperclipClient.getProjectWorkspace(channel.paperclipRefId);
        cwd = workspace.workspaceDir ?? workspace.path ?? agentHome;
      }
      break;
    }
    case "task_thread": {
      if (channel.paperclipRefId) {
        const issue = await paperclipClient.getIssue(channel.paperclipRefId);
        if (issue.projectId) {
          const workspace = await paperclipClient.getProjectWorkspace(issue.projectId);
          cwd = workspace.workspaceDir ?? workspace.path ?? agentHome;
        }
      }
      break;
    }
    case "dm":
    case "company_general":
    default:
      cwd = agentHome;
  }

  assertChatSessionIsolation(sessionPath);

  return {
    cwd,
    sessionPath,
  };
}

function assertChatSessionIsolation(sessionPath: string): void {
  const forbidden = path.join(os.homedir(), ".claude", "projects");
  if (sessionPath.startsWith(forbidden)) {
    throw new Error(`Chat session path must not use Paperclip project namespace: ${sessionPath}`);
  }
}
