import type { PaperclipClient } from "../adapters/paperclipClient.js";

export interface HumanAuthRequest {
  cookies?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  userId?: string;
  companyId?: string;
}

export interface HumanAuthResponse {
  status(code: number): HumanAuthResponse;
  json(body: unknown): unknown;
}

export type NextFunction = () => unknown | Promise<unknown>;

export async function validateHuman(
  req: HumanAuthRequest,
  res: HumanAuthResponse,
  next: NextFunction,
  paperclipClient: Pick<PaperclipClient, "validateSession">,
): Promise<unknown> {
  const sessionCookie = readCookie(req, "paperclip-session");
  if (!sessionCookie) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const session = await paperclipClient.validateSession(sessionCookie);
    req.userId = session.userId;
    req.companyId = session.companyId;
    return next();
  } catch {
    return res.status(401).json({ error: "Not authenticated" });
  }
}

function readCookie(req: HumanAuthRequest, key: string): string | null {
  const fromMap = req.cookies?.[key];
  if (fromMap) {
    return fromMap;
  }

  const rawCookieHeader = req.headers?.cookie;
  if (!rawCookieHeader) {
    return null;
  }

  for (const part of rawCookieHeader.split(";")) {
    const [cookieKey, ...cookieValue] = part.trim().split("=");
    if (cookieKey === key) {
      return cookieValue.join("=") || null;
    }
  }

  return null;
}
