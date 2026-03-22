import type { CreateChannel, Channel } from "@paperclip-chat/shared";
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
  create(input: Omit<CreateChannel, "participants">): Promise<Channel>;
}

export interface SeedChannelsResult {
  created: number;
  companies: number;
  projects: number;
}

export class ChannelService {
  constructor(
    private readonly repository: ChannelRepository,
    private readonly paperclipClient: Pick<PaperclipClient, "listCompanies" | "listProjects">,
  ) {}

  async listChannels(companyId: string): Promise<Channel[]> {
    return this.repository.listByCompany(companyId);
  }

  async getChannel(channelId: string): Promise<Channel | null> {
    return this.repository.getById(channelId);
  }

  async createChannel(input: Omit<CreateChannel, "participants">): Promise<Channel> {
    return this.repository.create(input);
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
    });
    return 1;
  }
}
