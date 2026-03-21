import { describe, expect, it, vi } from "vitest";
import { ChannelService, type ChannelRepository } from "./service.js";

describe("ChannelService", () => {
  it("seeds company_general and project channels idempotently", async () => {
    const created: Array<{ type: string; companyId: string; name: string; paperclipRefId?: string }> = [];
    const state = new Map<string, { id: string; type: "company_general" | "project" | "dm" | "task_thread"; companyId: string; paperclipRefId: string | null; name: string }>();
    const repository: ChannelRepository = {
      listByCompany: vi.fn().mockImplementation(async (companyId: string) =>
        [...state.values()].filter((channel) => channel.companyId === companyId),
      ),
      findCompanyGeneral: vi.fn().mockImplementation(async (companyId: string) =>
        [...state.values()].find((channel) => channel.companyId === companyId && channel.type === "company_general") ?? null,
      ),
      findProjectChannel: vi.fn().mockImplementation(async (companyId: string, paperclipRefId: string) =>
        [...state.values()].find(
          (channel) => channel.companyId === companyId && channel.type === "project" && channel.paperclipRefId === paperclipRefId,
        ) ?? null,
      ),
      create: vi.fn().mockImplementation(async (input) => {
        created.push(input);
        const channel = {
          id: `${state.size + 1}`,
          type: input.type,
          companyId: input.companyId,
          paperclipRefId: input.paperclipRefId ?? null,
          name: input.name,
        };
        state.set(channel.id, channel);
        return channel;
      }),
    };

    const service = new ChannelService(repository, {
      listCompanies: vi.fn().mockResolvedValue([{ id: "company-1", name: "Acme" }]),
      listProjects: vi.fn().mockResolvedValue([
        { id: "project-1", companyId: "company-1", name: "Project One" },
        { id: "project-2", companyId: "company-1", name: "Project Two" },
      ]),
    });

    const firstSeed = await service.seedChannels();
    const secondSeed = await service.seedChannels();

    expect(firstSeed).toEqual({ created: 3, companies: 1, projects: 2 });
    expect(secondSeed).toEqual({ created: 0, companies: 1, projects: 2 });
    expect(created).toEqual([
      {
        type: "company_general",
        companyId: "company-1",
        name: "Acme General",
        paperclipRefId: "company-1",
      },
      {
        type: "project",
        companyId: "company-1",
        name: "Project One",
        paperclipRefId: "project-1",
      },
      {
        type: "project",
        companyId: "company-1",
        name: "Project Two",
        paperclipRefId: "project-2",
      },
    ]);
  });
});
