import { randomUUID } from "node:crypto";

const SERVICE_ACCOUNT_NAME = "paperclip-chat-server";
const SERVICE_ACCOUNT_ROLE = "general";
const SERVICE_ACCOUNT_ADAPTER_TYPE = "http";
const HEALTHCHECK_INTERVAL_MS = 60_000;

export interface ServiceAccountEnv {
  paperclipApiUrl: string;
  chatServiceKey: string;
}

export interface ServiceAccountRecord {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface ServiceAccountState {
  serviceAccount: ServiceAccountRecord | null;
  healthcheckTimer: NodeJS.Timeout;
}

export class ServiceAccountError extends Error {}

export function readServiceAccountEnv(env: NodeJS.ProcessEnv = process.env): ServiceAccountEnv {
  const paperclipApiUrl = env.PAPERCLIP_API_URL?.trim();
  const chatServiceKey = env.CHAT_SERVICE_KEY?.trim();

  if (!chatServiceKey) {
    throw new ServiceAccountError("CHAT_SERVICE_KEY required");
  }

  if (!paperclipApiUrl) {
    throw new ServiceAccountError("PAPERCLIP_API_URL required");
  }

  return {
    paperclipApiUrl,
    chatServiceKey,
  };
}

export async function validateServiceAccount(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceAccountRecord> {
  const response = await fetchImpl(new URL("/api/agents", env.paperclipApiUrl), {
    headers: buildHeaders(env.chatServiceKey),
  });

  if (!response.ok) {
    throw new ServiceAccountError(`Failed to validate service account: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const agents = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { agents?: unknown[] })?.agents)
      ? ((payload as { agents: unknown[] }).agents)
      : [];

  const existing = agents.find((agent) => isNamedServiceAccount(agent, SERVICE_ACCOUNT_NAME));
  return (existing as ServiceAccountRecord | undefined) ?? { name: SERVICE_ACCOUNT_NAME };
}

export async function registerServiceAccount(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceAccountRecord> {
  const response = await fetchImpl(new URL("/api/agents", env.paperclipApiUrl), {
    method: "POST",
    headers: {
      ...buildHeaders(env.chatServiceKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: SERVICE_ACCOUNT_NAME,
      adapterType: SERVICE_ACCOUNT_ADAPTER_TYPE,
      role: SERVICE_ACCOUNT_ROLE,
    }),
  });

  if (!response.ok) {
    throw new ServiceAccountError(`Failed to register service account: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ServiceAccountRecord;
}

export async function ensureServiceAccount(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceAccountRecord> {
  await registerServiceAccount(env, fetchImpl);
  return validateServiceAccount(env, fetchImpl);
}

export async function startServiceAccountLifecycle(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
  logger: Pick<Console, "info" | "warn"> = console,
): Promise<ServiceAccountState> {
  const serviceAccount = await ensureServiceAccount(env, fetchImpl);
  logger.info(`Service account validated: ${serviceAccount.name ?? SERVICE_ACCOUNT_NAME}`);

  const healthcheckTimer = setInterval(async () => {
    try {
      await validateServiceAccount(env, fetchImpl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Service account health check failed: ${message}`);
    }
  }, HEALTHCHECK_INTERVAL_MS);

  return {
    serviceAccount,
    healthcheckTimer,
  };
}

export function stopServiceAccountLifecycle(state: ServiceAccountState): void {
  clearInterval(state.healthcheckTimer);
}

function buildHeaders(chatServiceKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${chatServiceKey}`,
    "X-Paperclip-Run-Id": `chat-server-${randomUUID()}`,
  };
}

function isNamedServiceAccount(value: unknown, expectedName: string): boolean {
  return typeof value === "object" && value !== null && "name" in value && (value as { name?: unknown }).name === expectedName;
}

