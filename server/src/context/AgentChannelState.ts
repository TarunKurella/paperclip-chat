import { CHAT_DEFAULTS, type AgentChannelState } from "@paperclip-chat/shared";

export function transitionOnMention(
  state: AgentChannelState,
  currentSeq: number,
  activeThreshold: number = CHAT_DEFAULTS.K_ACTIVE_THRESHOLD,
): AgentChannelState {
  if (state.status === "active" && currentSeq - state.anchorSeq >= activeThreshold) {
    return {
      ...state,
      status: "observing",
    };
  }

  return state;
}

export function transitionOnCompletion(
  state: AgentChannelState,
  newSeq: number,
): AgentChannelState {
  return {
    ...state,
    anchorSeq: newSeq,
    idleTurnCount: 0,
    status: "active",
  };
}

export function incrementIdle(
  states: AgentChannelState[],
  excludeParticipantId: string,
  activeThreshold: number = CHAT_DEFAULTS.K_ACTIVE_THRESHOLD,
): AgentChannelState[] {
  return states.map((state) => {
    if (state.participantId === excludeParticipantId) {
      return state;
    }

    const nextIdle = state.idleTurnCount + 1;
    return {
      ...state,
      idleTurnCount: nextIdle,
      status: state.status === "active" && nextIdle >= activeThreshold ? "observing" : state.status,
    };
  });
}
