import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { channelRoutes } from "./routes.js";

describe("channelRoutes", () => {
  it("lists channels by company", async () => {
    const service = {
      listChannels: vi.fn().mockResolvedValue([
        {
          id: "channel-1",
          type: "company_general",
          companyId: "company-1",
          paperclipRefId: "company-1",
          name: "Acme General",
        },
      ]),
      createChannel: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use("/api", channelRoutes(service as never));

    const response = await request(app).get("/api/channels").query({ companyId: "11111111-1111-4111-8111-111111111111" });

    expect(response.status).toBe(200);
    expect(service.listChannels).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("creates a channel", async () => {
    const service = {
      listChannels: vi.fn(),
      createChannel: vi.fn().mockResolvedValue({
        id: "channel-1",
        type: "dm",
        companyId: "11111111-1111-4111-8111-111111111111",
        paperclipRefId: null,
        name: "DM",
      }),
    };
    const app = express();
    app.use(express.json());
    app.use("/api", channelRoutes(service as never));

    const response = await request(app)
      .post("/api/channels")
      .send({
        type: "dm",
        companyId: "11111111-1111-4111-8111-111111111111",
        name: "DM",
      });

    expect(response.status).toBe(201);
    expect(service.createChannel).toHaveBeenCalledWith({
      type: "dm",
      companyId: "11111111-1111-4111-8111-111111111111",
      name: "DM",
      paperclipRefId: undefined,
    });
  });
});
