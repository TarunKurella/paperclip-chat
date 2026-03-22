import type { AgentChannelState } from "@paperclip-chat/shared";
import { describe, expect, it } from "vitest";
import { incrementIdle, transitionOnCompletion, transitionOnMention } from "./AgentChannelState.js";

describe("AgentChannelState", () => {
  it("keeps a new agent absent on mention until completion", () => {
    const state = makeState({ status: "absent", anchorSeq: 0, idleTurnCount: 0 });

    expect(transitionOnMention(state, 1)).toMatchObject({ status: "absent" });
  });

  it("transitions an agent to active on completion and updates anchor", () => {
    const state = makeState({ status: "observing", anchorSeq: 4, idleTurnCount: 7 });

    expect(transitionOnCompletion(state, 12)).toMatchObject({
      status: "active",
      anchorSeq: 12,
      idleTurnCount: 0,
    });
  });

  it("moves active agents to observing when idle count reaches the threshold", () => {
    const states = incrementIdle(
      [
        makeState({ participantId: "agent-1", status: "active", idleTurnCount: 4 }),
        makeState({ participantId: "agent-2", status: "active", idleTurnCount: 1 }),
      ],
      "agent-2",
      5,
    );

    expect(states[0]).toMatchObject({ participantId: "agent-1", status: "observing", idleTurnCount: 5 });
    expect(states[1]).toMatchObject({ participantId: "agent-2", status: "active", idleTurnCount: 1 });
  });

  it("returns observing on mention when an active agent has gone stale", () => {
    const state = makeState({ status: "active", anchorSeq: 2 });

    expect(transitionOnMention(state, 9, 5)).toMatchObject({ status: "observing" });
  });
});

function makeState(overrides: Partial<AgentChannelState> = {}): AgentChannelState {
  return {
    id: "state-1",
    sessionId: "session-1",
    participantId: "agent-1",
    status: "active",
    anchorSeq: 0,
    scaffoldIssueId: null,
    cliSessionId: null,
    cliSessionPath: null,
    idleTurnCount: 0,
    tokensThisSession: 0,
    ...overrides,
  };
}
