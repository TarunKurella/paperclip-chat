import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { notificationRoutes } from "./routes.js";

describe("notificationRoutes", () => {
  it("lists unread notifications for the authenticated human", async () => {
    const sessionManager = {
      listNotifications: vi.fn().mockResolvedValue([{ id: "notification-1" }]),
      markNotificationsRead: vi.fn(),
    };

    const app = express();
    app.use(express.json());
    app.use(injectHumanPrincipal());
    app.use("/api", notificationRoutes(sessionManager as never));

    const response = await request(app).get("/api/notifications");

    expect(response.status).toBe(200);
    expect(sessionManager.listNotifications).toHaveBeenCalledWith("human-1");
    expect(response.body.notifications).toEqual([{ id: "notification-1" }]);
  });

  it("marks either all notifications or a specific subset as read", async () => {
    const sessionManager = {
      listNotifications: vi.fn(),
      markNotificationsRead: vi.fn().mockResolvedValue(undefined),
    };

    const app = express();
    app.use(express.json());
    app.use(injectHumanPrincipal());
    app.use("/api", notificationRoutes(sessionManager as never));

    const response = await request(app)
      .post("/api/notifications/read")
      .send({ notificationIds: ["11111111-1111-4111-8111-111111111111"] });

    expect(response.status).toBe(204);
    expect(sessionManager.markNotificationsRead).toHaveBeenCalledWith("human-1", [
      "11111111-1111-4111-8111-111111111111",
    ]);
  });
});

function injectHumanPrincipal() {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { principal?: { type: "human"; id: string } }).principal = {
      type: "human",
      id: "human-1",
    };
    next();
  };
}
