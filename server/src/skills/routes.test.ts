import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { skillRoutes } from "./routes.js";
import { INLINE_CHAT_PROTOCOL } from "./protocol.js";

describe("skillRoutes", () => {
  it("serves the paperclip chat skill markdown publicly", async () => {
    const app = express();
    app.use("/api", skillRoutes());

    const response = await request(app).get("/api/skills/paperclip-chat");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/markdown");
    expect(response.text).toContain("CHAT_API_URL");
    expect(response.text).toContain("CHAT_SESSION_ID");
    expect(response.text).toContain("CHAT_API_TOKEN");
    expect(response.text).toContain("/api/sessions/$CHAT_SESSION_ID/send");
    expect(response.text).toContain("[DECISION]");
    expect(response.text).toContain("/crystallize");
  });
});

describe("INLINE_CHAT_PROTOCOL", () => {
  it("contains the fallback protocol for first-turn injection", () => {
    expect(INLINE_CHAT_PROTOCOL).toContain("POST $CHAT_API_URL/api/sessions/$CHAT_SESSION_ID/send");
    expect(INLINE_CHAT_PROTOCOL).toContain("[DECISION]");
    expect(INLINE_CHAT_PROTOCOL).toContain("GET $CHAT_API_URL/api/channels");
  });
});
