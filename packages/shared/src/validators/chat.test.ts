import { describe, expect, it } from "vitest";
import {
  closeSessionSchema,
  createChannelSchema,
  openSessionSchema,
  sendMessageSchema,
} from "./chat.js";

const uuidA = "11111111-1111-4111-8111-111111111111";
const uuidB = "22222222-2222-4222-8222-222222222222";

describe("chat validators", () => {
  it("accepts a valid send message payload", () => {
    const result = sendMessageSchema.parse({
      text: "Need a response from @agent",
      mentionedIds: [uuidA],
      summarize: true,
    });

    expect(result.text).toBe("Need a response from @agent");
    expect(result.mentionedIds).toEqual([uuidA]);
  });

  it("rejects an empty message", () => {
    expect(() => sendMessageSchema.parse({ text: "   " })).toThrow();
  });

  it("validates session open payloads", () => {
    const result = openSessionSchema.parse({
      channelId: uuidA,
      participantIds: [uuidA, uuidB],
    });

    expect(result.participantIds).toHaveLength(2);
  });

  it("defaults crystallize to false on close", () => {
    expect(closeSessionSchema.parse({})).toEqual({ crystallize: false });
  });

  it("validates create channel payloads", () => {
    const result = createChannelSchema.parse({
      type: "project",
      companyId: uuidA,
      name: "Search Ranking",
      participants: [{ participantType: "agent", participantId: uuidB }],
    });

    expect(result.type).toBe("project");
    expect(result.participants[0]?.participantType).toBe("agent");
  });

  it("rejects invalid channel types", () => {
    expect(() =>
      createChannelSchema.parse({
        type: "random",
        companyId: uuidA,
        name: "Broken",
        participants: [{ participantType: "human", participantId: uuidB }],
      }),
    ).toThrow();
  });
});
