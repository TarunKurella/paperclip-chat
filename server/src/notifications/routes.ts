import { Router, type RequestHandler, type Router as ExpressRouter } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../auth/authenticate.js";
import type { SessionManager } from "../session/SessionManager.js";

export interface NotificationRouteAuth {
  authenticate?: RequestHandler;
  requireHuman?: RequestHandler;
}

const markReadSchema = z.object({
  notificationIds: z.array(z.string().uuid()).optional(),
});

const passThrough: RequestHandler = (_req, _res, next) => next();

export function notificationRoutes(
  sessionManager: Pick<SessionManager, "listNotifications" | "markNotificationsRead">,
  auth: NotificationRouteAuth = {},
): ExpressRouter {
  const router = Router();

  router.get("/notifications", auth.authenticate ?? passThrough, auth.requireHuman ?? passThrough, async (req, res) => {
    const userId = getHumanUserId(req as AuthenticatedRequest);
    const notifications = await sessionManager.listNotifications(userId);
    res.json({ notifications });
  });

  router.post(
    "/notifications/read",
    auth.authenticate ?? passThrough,
    auth.requireHuman ?? passThrough,
    async (req, res) => {
      const userId = getHumanUserId(req as AuthenticatedRequest);
      const { notificationIds } = markReadSchema.parse(req.body ?? {});
      await sessionManager.markNotificationsRead(userId, notificationIds);
      res.status(204).send();
    },
  );

  return router;
}

function getHumanUserId(req: AuthenticatedRequest): string {
  if (req.principal?.type !== "human") {
    throw new Error("Human principal required");
  }

  return req.principal.id;
}
