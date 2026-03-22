import type { Turn } from "@paperclip-chat/shared";
import { assemblePacket, shouldUseDmShortcut } from "../context/PacketAssembler.js";
import type { ContextStore } from "../context/store.js";
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
    private readonly context: Pick<ContextStore, "listChunks" | "getSummary">,
    private readonly channels: Pick<ChannelService, "getChannel">,
    private readonly paperclipClient: Pick<PaperclipClient, "getAgent">,
    private readonly subprocessManager: Pick<SubprocessManager, "run">,
    private readonly wakeupManager: Pick<WakeupScaffoldManager, "flushMentionBatch">,
  ) {}

  async flush(agentId: string, sessionId: string, turns: Turn[]): Promise<void> {
    debugDispatch("coordinator.flush.start", { agentId, sessionId, turnCount: turns.length });
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      debugDispatch("coordinator.flush.missing_session", { agentId, sessionId });
      return;
    }

    const channel = await this.channels.getChannel(session.channelId);
    if (!channel) {
      debugDispatch("coordinator.flush.missing_channel", { agentId, sessionId, channelId: session.channelId });
      return;
    }

    const agent = await this.paperclipClient.getAgent(agentId);
    debugDispatch("coordinator.flush.agent", {
      agentId,
      sessionId,
      adapterType: agent.adapterType ?? null,
      status: agent.status ?? null,
      channelType: channel.type,
    });
    if (agent.adapterType === "http" || agent.adapterType === "process") {
      await this.wakeupManager.flushMentionBatch({ agentId, sessionId, channel, turns });
      return;
    }

    const participants = await this.sessions.listSessionParticipants(sessionId);
    const useDmShortcut = shouldUseDmShortcut(channel.type, participants.length);
    const contextFloorSeq = session.lastCrystallizedSeq ?? 0;
    const agentStates = await this.sessions.listAgentStates(sessionId);
    const agentState = agentStates.find((state) => state.participantId === agentId) ?? (
      useDmShortcut
        ? {
            id: `dm-${sessionId}-${agentId}`,
            sessionId,
            participantId: agentId,
            status: "absent" as const,
            anchorSeq: 0,
            scaffoldIssueId: null,
            cliSessionId: null,
            cliSessionPath: null,
            idleTurnCount: 0,
            tokensThisSession: 0,
          }
        : null
    );
    if (!agentState) {
      debugDispatch("coordinator.flush.missing_agent_state", { agentId, sessionId });
      return;
    }

    const priorTurns = await this.sessions.listTurns(sessionId, { limit: 200 });
    const globalSummary = contextFloorSeq > 0 ? null : await this.context.getSummary(sessionId);
    const triggeringTurn = toBatchedTrigger(turns);
    const senderName = turns.length === 1 ? turns[0]!.fromParticipantId : "Recent messages";
    const chunks = useDmShortcut || agentState.status === "absent"
      ? []
      : (await this.context.listChunks(sessionId)).filter(
          (chunk) =>
            chunk.chunkEnd > Math.max(agentState.anchorSeq, contextFloorSeq),
        );

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
      chunks,
      globalSummary,
      contextFloorSeq,
    });

    const result = await this.subprocessManager.run({
      adapterType: agent.adapterType ?? "claude_local",
      agentStatus: agent.status ?? null,
      agentId,
      agentName: agent.name || agentId,
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
      debugDispatch("coordinator.flush.queued", { agentId, sessionId });
      this.queuePending(agentId, sessionId, turns);
    } else {
      debugDispatch("coordinator.flush.completed", { agentId, sessionId });
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

function debugDispatch(event: string, payload: Record<string, unknown>) {
  if (process.env.CHAT_DEBUG_DISPATCH !== "1") {
    return;
  }

  console.log(`[chat-dispatch] ${event}`, payload);
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
