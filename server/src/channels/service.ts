import type { CreateChannel, Channel, SessionParticipant } from "@paperclip-chat/shared";
import type { PaperclipClient, PaperclipCompany } from "../adapters/paperclipClient.js";

export interface PaperclipProject {
  id: string;
  companyId?: string;
  name: string;
}

export interface ChannelRepository {
  listByCompany(companyId: string): Promise<Channel[]>;
  getById(channelId: string): Promise<Channel | null>;
  findCompanyGeneral(companyId: string): Promise<Channel | null>;
  findProjectChannel(companyId: string, paperclipRefId: string): Promise<Channel | null>;
  create(input: CreateChannel): Promise<Channel>;
}

export interface SeedChannelsResult {
  created: number;
  companies: number;
  projects: number;
}

export interface CompanyDirectoryEntry extends SessionParticipant {}

export class ChannelService {
  constructor(
    private readonly repository: ChannelRepository,
    private readonly paperclipClient: Pick<PaperclipClient, "listCompanies" | "listProjects" | "listCompanyAgents" | "listCompanyMembers">,
  ) {}

  async listChannels(companyId: string): Promise<Channel[]> {
    return this.repository.listByCompany(companyId);
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    return this.repository.getById(channelId);
  }

  async createChannel(input: CreateChannel): Promise<Channel> {
    if (input.type === "dm" && input.participants.length !== 1) {
      throw new Error("DM channels require exactly one target participant");
    }

    return this.repository.create(input);
  }

  async listCompanyDirectory(companyId: string): Promise<CompanyDirectoryEntry[]> {
    const [members, agents] = await Promise.all([
      this.paperclipClient.listCompanyMembers(companyId),
      this.paperclipClient.listCompanyAgents(companyId),
    ]);

    const humans = members
      .filter((member) => member.principalType === "user")
      .map<CompanyDirectoryEntry>((member) => ({
        participantId: member.principalId,
        participantType: "human",
        companyId,
        displayName: humanDisplayName(member.principalId),
        mentionLabel: slugifyName(humanDisplayName(member.principalId)),
      }));
    const companyAgents = agents
      .filter((agent) => !isInternalChatAgent(agent.name, agent.urlKey))
      .map<CompanyDirectoryEntry>((agent) => ({
        participantId: agent.id,
        participantType: "agent",
        companyId,
        displayName: agent.name,
        mentionLabel: agent.urlKey ?? slugifyName(agent.name),
      }));

    return dedupeEntries([...humans, ...companyAgents]);
  }

  async seedChannels(): Promise<SeedChannelsResult> {
    const companies = await this.paperclipClient.listCompanies();
    let created = 0;
    let projectCount = 0;

    for (const company of companies) {
      created += await this.ensureCompanyGeneral(company);

      const projects = await this.paperclipClient.listProjects(company.id);
      projectCount += projects.length;
      for (const project of projects) {
        created += await this.ensureProjectChannel({
          ...project,
          companyId: project.companyId ?? company.id,
        });
      }
    }

    return {
      created,
      companies: companies.length,
      projects: projectCount,
    };
  }

  private async ensureCompanyGeneral(company: PaperclipCompany): Promise<number> {
    const existing = await this.repository.findCompanyGeneral(company.id);
    if (existing) {
      return 0;
    }

    await this.repository.create({
      type: "company_general",
      companyId: company.id,
      name: company.name?.trim() ? `${company.name} General` : "Company General",
      paperclipRefId: company.id,
      participants: [],
    });
    return 1;
  }

  private async ensureProjectChannel(project: Required<PaperclipProject>): Promise<number> {
    const existing = await this.repository.findProjectChannel(project.companyId, project.id);
    if (existing) {
      return 0;
    }

    await this.repository.create({
      type: "project",
      companyId: project.companyId,
      name: project.name,
      paperclipRefId: project.id,
      participants: [],
    });
    return 1;
  }
}

function dedupeEntries(entries: CompanyDirectoryEntry[]): CompanyDirectoryEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.participantId)) {
      return false;
    }
    seen.add(entry.participantId);
    return true;
  });
}

function humanDisplayName(principalId: string): string {
  const normalized = principalId.replace(/^local-/, "");
  const parts = normalized.split(/[-_]/g).filter(Boolean);
  if (parts.length === 0) {
    return principalId;
  }

  return parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

function slugifyName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "participant";
}

function isInternalChatAgent(name?: string, urlKey?: string): boolean {
  return name === "paperclip-chat-server" || urlKey === "paperclip-chat-server";
}
