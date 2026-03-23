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
  contextFloorSeq?: number;
  kTokens?: number;
  packetBudget?: number;
  activeThreshold?: number;
  preferForegroundFastPath?: boolean;
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
  const contextFloorSeq = input.contextFloorSeq ?? 0;
  const effectiveAnchorSeq = Math.max(input.agentState.anchorSeq, contextFloorSeq);
  const deltaSinceAnchor = input.currentSeq - effectiveAnchorSeq;
  const usedHotShortcut = input.preferForegroundFastPath || deltaSinceAnchor <= activeThreshold;
  const mode = input.agentState.status === "absent"
    ? "absent"
    : input.agentState.status === "active" || usedHotShortcut
      ? "active"
      : "observing";

  const priorTurns = input.turns.filter(
    (turn) => turn.seq > effectiveAnchorSeq && turn.seq < input.triggeringTurn.seq,
  );
  const tailTurns = buildVerbatimTail(priorTurns, kTokens);
  if (input.preferForegroundFastPath) {
    const fastSections: string[] = [];
    if (input.agentState.status === "absent" && input.bootstrapPrompt?.trim()) {
      fastSections.push(input.bootstrapPrompt.trim());
    }
    if (tailTurns.length > 0) {
      fastSections.push(formatTail(tailTurns));
    }
    fastSections.push(formatTriggeringMessage(input.senderName, input.agentName, input.triggeringTurn.content));
    return {
      mode,
      usedHotShortcut,
      text: fastSections.filter(Boolean).join("\n\n"),
    };
  }

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

  sections.push(buildContextShiftHeader(input.channelName, effectiveAnchorSeq));

  if (mode === "absent" && contextFloorSeq === 0 && input.globalSummary?.text) {
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
    "This is a shared live room with humans and other agents. Stay in-role as a participant, not a generic assistant session.",
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
    "[Guidance]",
    "- Respond to the current room state, not to an imaginary standalone user prompt.",
    "- Mention another participant only if you want them to act next.",
    "- If you are speaking to another agent in the room, use their @handle explicitly.",
    "- If the human asked you to ask another participant something, direct the question to that participant with @handle.",
    "- Do not create back-and-forth handoff loops after another agent has already taken over.",
    "- Answer directly when the room is already asking you, and hand off only when there is a real reason.",
  ].join("\n");
}

function formatTriggeringMessage(senderName: string, agentName: string, content: string): string {
  return [
    `[Latest turn for ${agentName}]`,
    `From: ${senderName}`,
    `Content: ${content}`,
    "Reply as a participant in this room.",
    "If you are addressing another agent in group chat, use their @handle explicitly.",
    "If the latest human turn asked you to ask another participant something, ask that participant directly with @handle.",
    "Do not create unnecessary handoff loops or duplicate asks that are already answered in the room.",
    "If another agent should take over, use one clear @mention plus the minimum context they need.",
  ].join("\n");
}
