import type { AgentChannelState, Channel, ChatSession, Turn } from "@paperclip-chat/shared";
import { assemblePacket } from "../context/PacketAssembler.js";
import type { ChannelService } from "../channels/service.js";
import type { PaperclipClient } from "../adapters/paperclipClient.js";
import type { SessionRepository } from "../session/SessionManager.js";
import type { SubprocessManager } from "./SubprocessManager.js";
import type { WakeupScaffoldManager } from "../wakeup/WakeupScaffoldManager.js";

interface PendingDispatch {
  sessionId: string;
  turns: Turn[];
}

export class AgentDispatchCoordinator {
  private readonly pending = new Map<string, PendingDispatch>();

  constructor(
    private readonly sessions: Pick<SessionRepository, "getSession" | "listSessionParticipants" | "listAgentStates" | "listTurns">,
    private readonly channels: Pick<ChannelService, "getChannel">,
    private readonly paperclipClient: Pick<PaperclipClient, "getAgent">,
    private readonly subprocessManager: Pick<SubprocessManager, "run">,
    private readonly wakeupManager: Pick<WakeupScaffoldManager, "flushMentionBatch">,
  ) {}

  async flush(agentId: string, sessionId: string, turns: Turn[]): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      return;
    }

    const channel = await this.channels.getChannel(session.channelId);
    if (!channel) {
      return;
    }

    const agent = await this.paperclipClient.getAgent(agentId);
    if (agent.adapterType === "http" || agent.adapterType === "process") {
      await this.wakeupManager.flushMentionBatch({ agentId, sessionId, channel, turns });
      return;
    }

    const agentStates = await this.sessions.listAgentStates(sessionId);
    const agentState = agentStates.find((state) => state.participantId === agentId);
    if (!agentState) {
      return;
    }

    const participants = await this.sessions.listSessionParticipants(sessionId);
    const priorTurns = await this.sessions.listTurns(sessionId, { limit: 200 });
    const triggeringTurn = toBatchedTrigger(turns);
    const senderName = turns.length === 1 ? turns[0]!.fromParticipantId : "Recent messages";

    const packet = assemblePacket({
      channelName: channel.name,
      channelType: channel.type,
      participantCount: participants.length,
      agentName: agent.name || agentId,
      senderName,
      bootstrapPrompt: agent.bootstrapPrompt ?? null,
      agentState,
      currentSeq: Math.max(session.currentSeq, triggeringTurn.seq),
      triggeringTurn,
      turns: priorTurns,
      chunks: [],
      globalSummary: null,
    });

    const result = await this.subprocessManager.run({
      adapterType: agent.adapterType ?? "claude_local",
      agentId,
      sessionId,
      channel,
      channelId: channel.id,
      prompt: packet.text,
      currentSeq: Math.max(session.currentSeq, triggeringTurn.seq),
      triggeringTurn,
      agentState,
      cliSessionId: agentState.cliSessionId,
    });

    if (result.status === "queued") {
      this.queuePending(agentId, sessionId, turns);
    } else {
      this.pending.delete(agentId);
    }
  }

  async flushPending(agentId: string): Promise<void> {
    const pending = this.pending.get(agentId);
    if (!pending) {
      return;
    }

    this.pending.delete(agentId);
    await this.flush(agentId, pending.sessionId, pending.turns);
  }

  private queuePending(agentId: string, sessionId: string, turns: Turn[]): void {
    const existing = this.pending.get(agentId);
    if (!existing || existing.sessionId !== sessionId) {
      this.pending.set(agentId, { sessionId, turns: [...turns] });
      return;
    }

    this.pending.set(agentId, {
      sessionId,
      turns: [...existing.turns, ...turns].sort((left, right) => left.seq - right.seq),
    });
  }
}

function toBatchedTrigger(turns: Turn[]): Turn {
  const lastTurn = turns[turns.length - 1];
  if (!lastTurn) {
    throw new Error("Expected at least one turn to dispatch");
  }

  if (turns.length === 1) {
    return lastTurn;
  }

  return {
    ...lastTurn,
    content: turns.map((turn) => `${turn.fromParticipantId}: ${turn.content}`).join("\n"),
    tokenCount: turns.reduce((sum, turn) => sum + turn.tokenCount, 0),
  };
}
