import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { channels } from "@paperclip-chat/db";
import type { CreateChannel, Channel } from "@paperclip-chat/shared";
import type { ChannelRepository } from "./service.js";

export class DbChannelRepository implements ChannelRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, never>>) {}

  async listByCompany(companyId: string): Promise<Channel[]> {
    const rows = await this.db
      .select()
      .from(channels)
      .where(eq(channels.companyId, companyId))
      .orderBy(asc(channels.type), asc(channels.name));

    return rows.map(mapChannelRow);
  }

  async getById(channelId: string): Promise<Channel | null> {
    const row = await this.db
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1)
      .then((results) => results[0] ?? null);

    return row ? mapChannelRow(row) : null;
  }

  async findCompanyGeneral(companyId: string): Promise<Channel | null> {
    const row = await this.db
      .select()
      .from(channels)
      .where(and(eq(channels.companyId, companyId), eq(channels.type, "company_general")))
      .limit(1)
      .then((results) => results[0] ?? null);

    return row ? mapChannelRow(row) : null;
  }

  async findProjectChannel(companyId: string, paperclipRefId: string): Promise<Channel | null> {
    const row = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, companyId),
          eq(channels.type, "project"),
          eq(channels.paperclipRefId, paperclipRefId),
        ),
      )
      .limit(1)
      .then((results) => results[0] ?? null);

    return row ? mapChannelRow(row) : null;
  }

  async create(input: Omit<CreateChannel, "participants">): Promise<Channel> {
    const row = await this.db
      .insert(channels)
      .values({
        type: input.type,
        companyId: input.companyId,
        paperclipRefId: input.paperclipRefId ?? null,
        name: input.name,
      })
      .returning()
      .then((results) => results[0]);

    return mapChannelRow(row);
  }
}

function mapChannelRow(row: typeof channels.$inferSelect): Channel {
  return {
    id: row.id,
    type: row.type,
    companyId: row.companyId,
    paperclipRefId: row.paperclipRefId,
    name: row.name,
  };
}
