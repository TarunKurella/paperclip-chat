import type { AgentChannelState, Channel, ChatSession, Turn } from "@paperclip-chat/shared";
import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface WakeupBatchInput {
  agentId: string;
  sessionId: string;
  channel: Channel;
  turns: Turn[];
}

export class WakeupScaffoldManager {
  constructor(
    private readonly paperclipClient: Pick<PaperclipClient, "getAgent" | "createIssue" | "checkoutIssue" | "postComment" | "wakeupAgent">,
    private readonly stateStore: {
      listAgentStates(sessionId: string): Promise<AgentChannelState[]>;
      saveScaffoldIssue(sessionId: string, participantId: string, scaffoldIssueId: string): Promise<void>;
    },
  ) {}

  async ensureSessionScaffold(session: ChatSession, channel: Channel, agentId: string): Promise<boolean> {
    const agent = await this.paperclipClient.getAgent(agentId);
    if (agent.adapterType !== "http" && agent.adapterType !== "process") {
      return false;
    }

    await this.ensureScaffoldIssue({
      agentId,
      sessionId: session.id,
      channel,
      turns: [],
    });
    return true;
  }

  async recoverSessionScaffolds(session: ChatSession, channel: Channel): Promise<void> {
    const states = await this.stateStore.listAgentStates(session.id);
    for (const state of states) {
      if (!state.scaffoldIssueId) {
        continue;
      }

      const agent = await this.paperclipClient.getAgent(state.participantId);
      if (agent.adapterType !== "http" && agent.adapterType !== "process") {
        continue;
      }

      await this.paperclipClient.checkoutIssue(state.scaffoldIssueId, state.participantId);
    }
  }

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
    const existing = await this.readPersistedIssueId(input.sessionId, input.agentId);
    if (existing) {
      return existing;
    }

    const issue = await this.paperclipClient.createIssue(input.channel.companyId, {
      title: `[CHAT] #${input.channel.name} / ${input.sessionId.slice(0, 8)}`,
      description: `Scaffold issue for paperclip-chat session ${input.sessionId}.`,
      labels: ["chat-session"],
    });
    await this.stateStore.saveScaffoldIssue(input.sessionId, input.agentId, issue.id);
    return issue.id;
  }

  private async readPersistedIssueId(sessionId: string, agentId: string): Promise<string | null> {
    const states = await this.stateStore.listAgentStates(sessionId);
    return states.find((state) => state.participantId === agentId)?.scaffoldIssueId ?? null;
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
