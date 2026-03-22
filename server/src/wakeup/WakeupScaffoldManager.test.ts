import { describe, expect, it, vi } from "vitest";
import { WakeupScaffoldManager } from "./WakeupScaffoldManager.js";

describe("WakeupScaffoldManager", () => {
  it("creates a scaffold issue, posts a batched comment, and wakes http agents", async () => {
    const paperclipClient = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", adapterType: "http", name: "Agent" }),
      createIssue: vi.fn().mockResolvedValue({ id: "issue-1" }),
      checkoutIssue: vi.fn().mockResolvedValue({ checkoutId: "checkout-1" }),
      postComment: vi.fn().mockResolvedValue({ id: "comment-1" }),
      wakeupAgent: vi.fn().mockResolvedValue({ status: "ok" }),
    };
    const stateStore = {
      listAgentStates: vi.fn().mockResolvedValue([
        {
          id: "state-1",
          sessionId: "session-12345678",
          participantId: "agent-1",
          status: "absent",
          anchorSeq: 0,
          scaffoldIssueId: null,
          cliSessionId: null,
          cliSessionPath: null,
          idleTurnCount: 0,
          tokensThisSession: 0,
        },
      ]),
      saveScaffoldIssue: vi.fn().mockResolvedValue(undefined),
    };

    const manager = new WakeupScaffoldManager(paperclipClient as never, stateStore);
    const handled = await manager.flushMentionBatch({
      agentId: "agent-1",
      sessionId: "session-12345678",
      channel: {
        id: "channel-1",
        type: "project",
        companyId: "company-1",
        paperclipRefId: null,
        name: "Search Ranking",
      },
      turns: [
        {
          id: "turn-1",
          sessionId: "session-12345678",
          seq: 1,
          fromParticipantId: "human-1",
          content: "@agent please review",
          tokenCount: 8,
          summarize: false,
          mentionedIds: ["agent-1"],
          isDecision: false,
          createdAt: new Date().toISOString(),
        },
      ],
    });

    expect(handled).toBe(true);
    expect(paperclipClient.createIssue).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "[CHAT] #Search Ranking / session-",
        labels: ["chat-session"],
      }),
    );
    expect(paperclipClient.checkoutIssue).toHaveBeenCalledWith("issue-1", "agent-1");
    expect(stateStore.saveScaffoldIssue).toHaveBeenCalledWith("session-12345678", "agent-1", "issue-1");
    expect(paperclipClient.postComment).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        body: expect.stringContaining("@agent please review"),
      }),
    );
    expect(paperclipClient.wakeupAgent).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      }),
    );
  });

  it("skips subprocess wakeup flow for non-http/process adapters", async () => {
    const paperclipClient = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", adapterType: "subprocess_cli", name: "Agent" }),
      createIssue: vi.fn(),
      checkoutIssue: vi.fn(),
      postComment: vi.fn(),
      wakeupAgent: vi.fn(),
    };
    const stateStore = {
      listAgentStates: vi.fn().mockResolvedValue([]),
      saveScaffoldIssue: vi.fn().mockResolvedValue(undefined),
    };

    const manager = new WakeupScaffoldManager(paperclipClient as never, stateStore);
    const handled = await manager.flushMentionBatch({
      agentId: "agent-1",
      sessionId: "session-12345678",
      channel: {
        id: "channel-1",
        type: "project",
        companyId: "company-1",
        paperclipRefId: null,
        name: "Search Ranking",
      },
      turns: [],
    });

    expect(handled).toBe(false);
    expect(paperclipClient.createIssue).not.toHaveBeenCalled();
    expect(paperclipClient.wakeupAgent).not.toHaveBeenCalled();
  });

  it("re-checks out persisted scaffold issues during recovery", async () => {
    const paperclipClient = {
      getAgent: vi.fn().mockResolvedValue({ id: "agent-1", adapterType: "http", name: "Agent" }),
      createIssue: vi.fn(),
      checkoutIssue: vi.fn().mockResolvedValue({ checkoutId: "checkout-1" }),
      postComment: vi.fn(),
      wakeupAgent: vi.fn(),
    };
    const stateStore = {
      listAgentStates: vi.fn().mockResolvedValue([
        {
          id: "state-1",
          sessionId: "session-12345678",
          participantId: "agent-1",
          status: "absent",
          anchorSeq: 0,
          scaffoldIssueId: "issue-1",
          cliSessionId: null,
          cliSessionPath: null,
          idleTurnCount: 0,
          tokensThisSession: 0,
        },
      ]),
      saveScaffoldIssue: vi.fn().mockResolvedValue(undefined),
    };

    const manager = new WakeupScaffoldManager(paperclipClient as never, stateStore);
    await manager.recoverSessionScaffolds(
      {
        id: "session-12345678",
        channelId: "channel-1",
        status: "active",
        chunkWindowWTokens: 1200,
        verbatimKTokens: 800,
        currentSeq: 1,
        lastCrystallizedSeq: null,
        lastCrystallizedIssueId: null,
      },
      {
        id: "channel-1",
        type: "project",
        companyId: "company-1",
        paperclipRefId: null,
        name: "Search Ranking",
      },
    );

    expect(paperclipClient.checkoutIssue).toHaveBeenCalledWith("issue-1", "agent-1");
  });
});
