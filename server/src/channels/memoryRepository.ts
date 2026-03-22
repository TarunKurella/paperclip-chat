import type { CreateChannel, Channel } from "@paperclip-chat/shared";
import type { ChannelRepository } from "./service.js";

export class InMemoryChannelRepository implements ChannelRepository {
  private readonly channels = new Map<string, Channel>();

  async listByCompany(companyId: string): Promise<Channel[]> {
    return [...this.channels.values()]
      .filter((channel) => channel.companyId === companyId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async getById(channelId: string): Promise<Channel | null> {
    return this.channels.get(channelId) ?? null;
  }

  async findCompanyGeneral(companyId: string): Promise<Channel | null> {
    return [...this.channels.values()].find(
      (channel) => channel.companyId === companyId && channel.type === "company_general",
    ) ?? null;
  }

  async findProjectChannel(companyId: string, paperclipRefId: string): Promise<Channel | null> {
    return [...this.channels.values()].find(
      (channel) =>
        channel.companyId === companyId &&
        channel.type === "project" &&
        channel.paperclipRefId === paperclipRefId,
    ) ?? null;
  }

  async create(input: Omit<CreateChannel, "participants">): Promise<Channel> {
    const channel: Channel = {
      id: crypto.randomUUID(),
      type: input.type,
      companyId: input.companyId,
      paperclipRefId: input.paperclipRefId ?? null,
      name: input.name,
    };
    this.channels.set(channel.id, channel);
    return channel;
  }
}
