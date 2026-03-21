import { randomUUID } from "node:crypto";
import { z } from "zod";

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  adapterType: z.string().optional(),
  role: z.string().optional(),
  workspaceDir: z.string().nullable().optional(),
  bootstrapPrompt: z.string().nullable().optional(),
});

const companySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
});

const projectSchema = z.object({
  id: z.string(),
  companyId: z.string().optional(),
  name: z.string(),
});

const issueSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable().optional(),
  title: z.string().optional(),
});

const checkoutSchema = z.object({
  checkoutId: z.string().optional(),
  workspacePath: z.string().nullable().optional(),
  issueId: z.string().optional(),
});

const commentSchema = z.object({
  id: z.string().optional(),
  issueId: z.string().optional(),
  body: z.string().optional(),
});

const wakeupSchema = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
});

const costSchema = z.object({
  id: z.string().optional(),
  accepted: z.boolean().optional(),
});

const sessionValidationSchema = z.object({
  userId: z.string(),
  companyId: z.string(),
  sessionId: z.string().optional(),
});

const currentAgentSchema = z.object({
  id: z.string(),
  companyId: z.string(),
});

const workspaceSchema = z.object({
  projectId: z.string().optional(),
  workspaceDir: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
});

const agentsListSchema = z.union([z.array(agentSchema), z.object({ agents: z.array(agentSchema) })]);

export type PaperclipAgent = z.infer<typeof agentSchema>;
export type PaperclipCompany = z.infer<typeof companySchema>;
export type PaperclipProject = z.infer<typeof projectSchema>;
export type PaperclipIssue = z.infer<typeof issueSchema>;
export type PaperclipSessionValidation = z.infer<typeof sessionValidationSchema>;
export type PaperclipCurrentAgent = z.infer<typeof currentAgentSchema>;

export interface PaperclipClientOptions {
  baseUrl: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
  retryDelaysMs?: number[];
}

export class PaperclipApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseText: string,
  ) {
    super(message);
  }
}

export class PaperclipClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, "warn">;
  private readonly retryDelaysMs: number[];

  constructor(private readonly options: PaperclipClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.retryDelaysMs = options.retryDelaysMs ?? [1_000, 2_000, 4_000];
  }

  async listAgents(): Promise<PaperclipAgent[]> {
    const payload = await this.requestJson("/api/agents");
    const parsed = agentsListSchema.parse(payload);
    return Array.isArray(parsed) ? parsed : parsed.agents;
  }

  async registerAgent(body: { name: string; adapterType: string; role: string }): Promise<PaperclipAgent> {
    return agentSchema.parse(
      await this.requestJson("/api/agents", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  async getAgent(agentId: string): Promise<PaperclipAgent> {
    return agentSchema.parse(await this.requestJson(`/api/agents/${agentId}`));
  }

  async getCompany(companyId: string): Promise<PaperclipCompany> {
    return companySchema.parse(await this.requestJson(`/api/companies/${companyId}`));
  }

  async listCompanies(): Promise<PaperclipCompany[]> {
    return z.array(companySchema).parse(await this.requestJson("/api/companies"));
  }

  async listProjects(companyId: string): Promise<PaperclipProject[]> {
    const projects = z.array(projectSchema).parse(await this.requestJson(`/api/companies/${companyId}/projects`));
    return projects.map((project) => ({
      ...project,
      companyId: project.companyId ?? companyId,
    }));
  }

  async createIssue(companyId: string, issue: Record<string, unknown>): Promise<PaperclipIssue> {
    return issueSchema.parse(
      await this.requestJson(`/api/companies/${companyId}/issues`, {
        method: "POST",
        body: JSON.stringify(issue),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  async checkoutIssue(issueId: string, agentId: string): Promise<z.infer<typeof checkoutSchema>> {
    return checkoutSchema.parse(
      await this.requestJson(`/api/issues/${issueId}/checkout`, {
        method: "POST",
        body: JSON.stringify({ agentId }),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  async postComment(issueId: string, comment: Record<string, unknown>): Promise<z.infer<typeof commentSchema>> {
    return commentSchema.parse(
      await this.requestJson(`/api/issues/${issueId}/comments`, {
        method: "POST",
        body: JSON.stringify(comment),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  async wakeupAgent(agentId: string, wakeup: Record<string, unknown>): Promise<z.infer<typeof wakeupSchema>> {
    return wakeupSchema.parse(
      await this.requestJson(`/api/agents/${agentId}/wakeup`, {
        method: "POST",
        body: JSON.stringify(wakeup),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  async postCost(costEvent: Record<string, unknown>): Promise<z.infer<typeof costSchema>> {
    return costSchema.parse(
      await this.requestJson("/api/costs", {
        method: "POST",
        body: JSON.stringify(costEvent),
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  async validateSession(cookie: string): Promise<PaperclipSessionValidation> {
    return sessionValidationSchema.parse(
      await this.requestJson("/api/auth/session", {
        headers: { Cookie: `paperclip-session=${cookie}` },
      }),
    );
  }

  async validateAgentJwt(token: string): Promise<PaperclipCurrentAgent> {
    return currentAgentSchema.parse(
      await this.requestJson(
        "/api/agents/me",
        {
          headers: { Authorization: `Bearer ${token}` },
        },
        { serviceAuth: false },
      ),
    );
  }

  async getProjectWorkspace(projectId: string): Promise<z.infer<typeof workspaceSchema>> {
    return workspaceSchema.parse(await this.requestJson(`/api/projects/${projectId}/workspace`));
  }

  async getIssue(issueId: string): Promise<PaperclipIssue> {
    return issueSchema.parse(await this.requestJson(`/api/issues/${issueId}`));
  }

  private async requestJson(
    pathname: string,
    init: RequestInit = {},
    options: { serviceAuth?: boolean } = {},
  ): Promise<unknown> {
    const url = new URL(pathname, this.baseUrl);
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            "X-Paperclip-Run-Id": `chat-server-${randomUUID()}`,
            ...(options.serviceAuth === false ? {} : { Authorization: `Bearer ${this.options.serviceKey}` }),
            ...(init.headers ?? {}),
          },
        });

        if (!response.ok) {
          const responseText = await response.text();
          if (response.status >= 500 && attempt < this.retryDelaysMs.length) {
            await sleep(this.retryDelaysMs[attempt] ?? 0);
            continue;
          }

          throw new PaperclipApiError(`Paperclip API request failed: ${response.status}`, response.status, responseText);
        }

        return response.json();
      } catch (error) {
        lastError = error;
        if (!shouldRetryError(error) || attempt >= this.retryDelaysMs.length) {
          throw error;
        }

        this.logger.warn(`Paperclip API request retrying after failure: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(this.retryDelaysMs[attempt] ?? 0);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function shouldRetryError(error: unknown): boolean {
  if (error instanceof PaperclipApiError) {
    return error.status >= 500;
  }

  return error instanceof Error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
