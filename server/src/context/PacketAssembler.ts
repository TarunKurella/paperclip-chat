import { CHAT_DEFAULTS, type AgentChannelState, type ChannelType, type SessionSummary, type TrunkChunk, type Turn } from "@paperclip-chat/shared";

export interface AssemblePacketInput {
  channelName: string;
  channelType: ChannelType;
  participantCount: number;
  agentName: string;
  senderName: string;
  bootstrapPrompt?: string | null;
  agentState: AgentChannelState;
  currentSeq: number;
  triggeringTurn: Turn;
  turns: Turn[];
  chunks: TrunkChunk[];
  globalSummary?: SessionSummary | null;
  kTokens?: number;
  packetBudget?: number;
  activeThreshold?: number;
}

export interface PacketAssemblyResult {
  mode: "absent" | "observing" | "active";
  usedHotShortcut: boolean;
  text: string;
}

export function assemblePacket(input: AssemblePacketInput): PacketAssemblyResult {
  const kTokens = input.kTokens ?? CHAT_DEFAULTS.K_TOKENS;
  const packetBudget = input.packetBudget ?? CHAT_DEFAULTS.PACKET_BUDGET;
  const activeThreshold = input.activeThreshold ?? CHAT_DEFAULTS.K_ACTIVE_THRESHOLD;
  const deltaSinceAnchor = input.currentSeq - input.agentState.anchorSeq;
  const usedHotShortcut = deltaSinceAnchor <= activeThreshold;
  const mode = input.agentState.status === "absent"
    ? "absent"
    : input.agentState.status === "active" || usedHotShortcut
      ? "active"
      : "observing";

  const priorTurns = input.turns.filter((turn) => turn.seq < input.triggeringTurn.seq);
  const tailTurns = buildVerbatimTail(priorTurns, kTokens);
  const tailStartSeq = tailTurns[0]?.seq ?? input.triggeringTurn.seq;

  if (mode === "active") {
    return {
      mode,
      usedHotShortcut,
      text: [
        formatTail(tailTurns),
        formatTriggeringMessage(input.senderName, input.agentName, input.triggeringTurn.content),
      ].filter(Boolean).join("\n\n"),
    };
  }

  const sections: string[] = [];
  if (mode === "absent" && input.bootstrapPrompt?.trim()) {
    sections.push(input.bootstrapPrompt.trim());
  }

  sections.push(buildContextShiftHeader(input.channelName, input.agentState.anchorSeq));

  if (mode === "absent" && input.globalSummary?.text) {
    sections.push(`[SUMMARY]\n${input.globalSummary.text}`);
  }

  if (mode === "observing") {
    const eligibleChunks = input.chunks.filter((chunk) => chunk.chunkEnd < tailStartSeq);
    const keptChunks = applyPacketBudget(eligibleChunks, packetBudget, tailTurns, input.triggeringTurn, input.globalSummary);
    if (keptChunks.length > 0) {
      sections.push(
        keptChunks
          .map((chunk) => `[CHUNK ${chunk.chunkStart}-${chunk.chunkEnd}]\n${chunk.summary}`)
          .join("\n\n"),
      );
    }
  }

  if (tailTurns.length > 0) {
    sections.push(formatTail(tailTurns));
  }

  sections.push(formatTriggeringMessage(input.senderName, input.agentName, input.triggeringTurn.content));

  return {
    mode,
    usedHotShortcut,
    text: sections.filter(Boolean).join("\n\n"),
  };
}

export function shouldUseDmShortcut(channelType: ChannelType, participantCount: number): boolean {
  return channelType === "dm" && participantCount === 2;
}

function buildVerbatimTail(turns: Turn[], kTokens: number): Turn[] {
  const selected: Turn[] = [];
  let consumed = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!turn) {
      continue;
    }

    if (consumed + turn.tokenCount > kTokens && selected.length > 0) {
      break;
    }

    consumed += turn.tokenCount;
    selected.unshift(turn);
  }

  return selected;
}

function applyPacketBudget(
  chunks: TrunkChunk[],
  packetBudget: number,
  tailTurns: Turn[],
  triggeringTurn: Turn,
  globalSummary?: SessionSummary | null,
): TrunkChunk[] {
  const tailTokens = tailTurns.reduce((sum, turn) => sum + turn.tokenCount, 0) + triggeringTurn.tokenCount;
  const summaryTokens = globalSummary?.tokenCount ?? 0;
  const chunkTokens = chunks.reduce((sum, chunk) => sum + chunk.summaryTokenCount, 0);

  if (summaryTokens + tailTokens + chunkTokens <= packetBudget || chunks.length <= 2) {
    return chunks;
  }

  return [chunks[0], chunks[chunks.length - 1]].filter((chunk): chunk is TrunkChunk => Boolean(chunk));
}

function buildContextShiftHeader(channelName: string, anchorSeq: number): string {
  return [
    `You are currently in a group chat via paperclip-chat (channel: #${channelName}).`,
    `You were last active at turn ${anchorSeq}. Here is what you missed:`,
  ].join("\n");
}

function formatTail(turns: Turn[]): string {
  if (turns.length === 0) {
    return "";
  }

  return [
    "[Recent turns verbatim]",
    ...turns.map((turn) => `${turn.fromParticipantId}: ${turn.content}`),
  ].join("\n");
}

function formatTriggeringMessage(senderName: string, agentName: string, content: string): string {
  return `[${senderName} @${agentName}]: ${content}`;
}
