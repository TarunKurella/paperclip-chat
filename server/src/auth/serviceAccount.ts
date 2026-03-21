import { randomUUID } from "node:crypto";

const SERVICE_ACCOUNT_NAME = "paperclip-chat-server";
const SERVICE_ACCOUNT_EVENTS_KEY_NAME = "paperclip-chat-live-events";
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
  companyId?: string;
  liveEventsToken?: string;
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
  const existing = await findServiceAccount(env, fetchImpl);
  if (existing) {
    return existing;
  }

  throw new ServiceAccountError(`Failed to validate service account: ${SERVICE_ACCOUNT_NAME} not found`);
}

export async function registerServiceAccount(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceAccountRecord> {
  const companies = await listCompanies(env, fetchImpl);
  if (companies.length === 0) {
    throw new ServiceAccountError("Failed to register service account: no companies found");
  }

  let firstRecord: ServiceAccountRecord | null = null;

  for (const company of companies) {
    const agents = await listCompanyAgents(env, company.id, fetchImpl);
    const existing = agents.find((agent) => isNamedServiceAccount(agent, SERVICE_ACCOUNT_NAME));
    if (existing) {
      firstRecord ??= withCompanyId(existing, company.id);
      continue;
    }

    const response = await fetchImpl(new URL(`/api/companies/${company.id}/agents`, env.paperclipApiUrl), {
      method: "POST",
      headers: {
        ...buildHeaders(env.chatServiceKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: SERVICE_ACCOUNT_NAME,
        adapterType: SERVICE_ACCOUNT_ADAPTER_TYPE,
        role: SERVICE_ACCOUNT_ROLE,
        adapterConfig: {},
      }),
    });

    if (!response.ok) {
      throw new ServiceAccountError(`Failed to register service account: ${response.status} ${response.statusText}`);
    }

    const created = withCompanyId((await response.json()) as ServiceAccountRecord, company.id);
    firstRecord ??= created;
  }

  if (!firstRecord) {
    throw new ServiceAccountError("Failed to register service account: no service account record returned");
  }

  return firstRecord;
}

export async function ensureServiceAccount(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceAccountRecord> {
  const existing = await findServiceAccount(env, fetchImpl);
  if (existing) {
    return existing;
  }

  await registerServiceAccount(env, fetchImpl);
  return validateServiceAccount(env, fetchImpl);
}

export async function startServiceAccountLifecycle(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch = fetch,
  logger: Pick<Console, "info" | "warn"> = console,
): Promise<ServiceAccountState> {
  const serviceAccount = await ensureServiceAccount(env, fetchImpl);
  const liveEventsToken = await issueLiveEventsToken(env, serviceAccount, fetchImpl);
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
    serviceAccount: {
      ...serviceAccount,
      liveEventsToken,
    },
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

async function findServiceAccount(
  env: ServiceAccountEnv,
  fetchImpl: typeof fetch,
): Promise<ServiceAccountRecord | null> {
  const companies = await listCompanies(env, fetchImpl);

  for (const company of companies) {
    const agents = await listCompanyAgents(env, company.id, fetchImpl);
    const existing = agents.find((agent) => isNamedServiceAccount(agent, SERVICE_ACCOUNT_NAME));
    if (existing) {
      return withCompanyId(existing, company.id);
    }
  }

  return null;
}

async function listCompanies(env: ServiceAccountEnv, fetchImpl: typeof fetch): Promise<Array<{ id: string }>> {
  const response = await fetchImpl(new URL("/api/companies", env.paperclipApiUrl), {
    headers: buildHeaders(env.chatServiceKey),
  });

  if (!response.ok) {
    throw new ServiceAccountError(`Failed to list companies: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const companies = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.companies)
      ? payload.companies
      : [];
  return companies.filter(isCompanyRecord).map((company) => ({ id: company.id }));
}

async function listCompanyAgents(
  env: ServiceAccountEnv,
  companyId: string,
  fetchImpl: typeof fetch,
): Promise<ServiceAccountRecord[]> {
  const response = await fetchImpl(new URL(`/api/companies/${companyId}/agents`, env.paperclipApiUrl), {
    headers: buildHeaders(env.chatServiceKey),
  });

  if (!response.ok) {
    throw new ServiceAccountError(`Failed to validate service account: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  const agents = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.agents)
      ? payload.agents
      : [];
  return agents.filter(isServiceAccountRecord);
}

async function issueLiveEventsToken(
  env: ServiceAccountEnv,
  serviceAccount: ServiceAccountRecord,
  fetchImpl: typeof fetch,
): Promise<string> {
  if (!serviceAccount.id) {
    throw new ServiceAccountError("Failed to issue live events key: service account id missing");
  }

  const existingKeys = await listAgentKeys(env, serviceAccount.id, fetchImpl);
  for (const key of existingKeys) {
    if (key.name !== SERVICE_ACCOUNT_EVENTS_KEY_NAME || typeof key.id !== "string" || key.revokedAt) {
      continue;
    }

    const revokeResponse = await fetchImpl(new URL(`/api/agents/${serviceAccount.id}/keys/${key.id}`, env.paperclipApiUrl), {
      method: "DELETE",
      headers: buildHeaders(env.chatServiceKey),
    });
    if (!revokeResponse.ok) {
      throw new ServiceAccountError(`Failed to revoke live events key: ${revokeResponse.status} ${revokeResponse.statusText}`);
    }
  }

  const createResponse = await fetchImpl(new URL(`/api/agents/${serviceAccount.id}/keys`, env.paperclipApiUrl), {
    method: "POST",
    headers: {
      ...buildHeaders(env.chatServiceKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: SERVICE_ACCOUNT_EVENTS_KEY_NAME }),
  });

  if (!createResponse.ok) {
    throw new ServiceAccountError(`Failed to create live events key: ${createResponse.status} ${createResponse.statusText}`);
  }

  const payload = (await createResponse.json()) as unknown;
  if (!isObject(payload) || typeof payload.token !== "string" || payload.token.length === 0) {
    throw new ServiceAccountError("Failed to create live events key: token missing");
  }

  return payload.token;
}

async function listAgentKeys(
  env: ServiceAccountEnv,
  agentId: string,
  fetchImpl: typeof fetch,
): Promise<Array<{ id?: string; name?: string; revokedAt?: string | null }>> {
  const response = await fetchImpl(new URL(`/api/agents/${agentId}/keys`, env.paperclipApiUrl), {
    headers: buildHeaders(env.chatServiceKey),
  });

  if (!response.ok) {
    throw new ServiceAccountError(`Failed to list live events keys: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? payload.filter(isKeyRecord) : [];
}

function isCompanyRecord(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

function isServiceAccountRecord(value: unknown): value is ServiceAccountRecord {
  return typeof value === "object" && value !== null;
}

function isKeyRecord(value: unknown): value is { id?: string; name?: string; revokedAt?: string | null } {
  return typeof value === "object" && value !== null;
}

function withCompanyId(record: ServiceAccountRecord, companyId: string): ServiceAccountRecord {
  return {
    ...record,
    companyId,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
