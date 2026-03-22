import type { Channel, Turn } from "@paperclip-chat/shared";
import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface WakeupBatchInput {
  agentId: string;
  sessionId: string;
  channel: Channel;
  turns: Turn[];
}

export class WakeupScaffoldManager {
  private readonly scaffoldIssueIds = new Map<string, string>();

  constructor(
    private readonly paperclipClient: Pick<PaperclipClient, "getAgent" | "createIssue" | "checkoutIssue" | "postComment" | "wakeupAgent">,
  ) {}

  async flushMentionBatch(input: WakeupBatchInput): Promise<boolean> {
    const agent = await this.paperclipClient.getAgent(input.agentId);
    if (agent.adapterType !== "http" && agent.adapterType !== "process") {
      return false;
    }

    const issueId = await this.ensureScaffoldIssue(input);
    await this.paperclipClient.checkoutIssue(issueId, input.agentId);
    const comment = await this.paperclipClient.postComment(issueId, {
      body: formatWakeupComment(input.channel, input.turns),
    });

    await this.paperclipClient.wakeupAgent(input.agentId, {
      source: "automation",
      reason: "issue_comment_mentioned",
      wakeCommentId: comment.id,
    });

    return true;
  }

  private async ensureScaffoldIssue(input: WakeupBatchInput): Promise<string> {
    const key = `${input.agentId}:${input.sessionId}`;
    const existing = this.scaffoldIssueIds.get(key);
    if (existing) {
      return existing;
    }

    const issue = await this.paperclipClient.createIssue(input.channel.companyId, {
      title: `[CHAT] #${input.channel.name} / ${input.sessionId.slice(0, 8)}`,
      description: `Scaffold issue for paperclip-chat session ${input.sessionId}.`,
      labels: ["chat-session"],
    });
    this.scaffoldIssueIds.set(key, issue.id);
    return issue.id;
  }
}

function formatWakeupComment(channel: Channel, turns: Turn[]): string {
  const lines = turns.map((turn) => `- ${turn.fromParticipantId}: ${turn.content}`);
  return [
    `paperclip-chat wakeup for #${channel.name}`,
    "",
    ...lines,
  ].join("\n");
}
