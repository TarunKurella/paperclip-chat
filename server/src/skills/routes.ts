import { Router, type Express, type Router as ExpressRouter } from "express";
import { readPaperclipChatSkill } from "./protocol.js";

export function skillRoutes(): ExpressRouter {
  const router = Router();

  router.get("/skills/paperclip-chat", (_req, res) => {
    res.type("text/markdown").send(readPaperclipChatSkill());
  });

  return router;
}
