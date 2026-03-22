import { describe, expect, it, vi } from "vitest";
import { ChannelService, type ChannelRepository } from "./service.js";

describe("ChannelService", () => {
  it("seeds company_general and project channels idempotently", async () => {
    const created: Array<{ type: string; companyId: string; name: string; paperclipRefId?: string; participants: unknown[] }> = [];
    const state = new Map<string, { id: string; type: "company_general" | "project" | "dm" | "task_thread"; companyId: string; paperclipRefId: string | null; name: string }>();
    const repository: ChannelRepository = {
      listByCompany: vi.fn().mockImplementation(async (companyId: string) =>
        [...state.values()].filter((channel) => channel.companyId === companyId),
      ),
      getById: vi.fn().mockImplementation(async (channelId: string) => state.get(channelId) ?? null),
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
      listCompanyMembers: vi.fn(),
      listCompanyAgents: vi.fn(),
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
        participants: [],
      },
      {
        type: "project",
        companyId: "company-1",
        name: "Project One",
        paperclipRefId: "project-1",
        participants: [],
      },
      {
        type: "project",
        companyId: "company-1",
        name: "Project Two",
        paperclipRefId: "project-2",
        participants: [],
      },
    ]);
  });

  it("returns a company directory with humans and non-internal agents", async () => {
    const repository: ChannelRepository = {
      listByCompany: vi.fn(),
      getById: vi.fn(),
      findCompanyGeneral: vi.fn(),
      findProjectChannel: vi.fn(),
      create: vi.fn(),
    };

    const service = new ChannelService(repository, {
      listCompanies: vi.fn(),
      listProjects: vi.fn(),
      listCompanyMembers: vi.fn().mockResolvedValue([
        {
          id: "member-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "local-board",
        },
      ]),
      listCompanyAgents: vi.fn().mockResolvedValue([
        {
          id: "agent-1",
          companyId: "company-1",
          name: "CEO",
          urlKey: "ceo",
        },
        {
          id: "agent-2",
          companyId: "company-1",
          name: "paperclip-chat-server",
          urlKey: "paperclip-chat-server",
        },
      ]),
    });

    await expect(service.listCompanyDirectory("company-1")).resolves.toEqual([
      {
        participantId: "local-board",
        participantType: "human",
        companyId: "company-1",
        displayName: "Board",
        mentionLabel: "board",
      },
      {
        participantId: "agent-1",
        participantType: "agent",
        companyId: "company-1",
        displayName: "CEO",
        mentionLabel: "ceo",
      },
    ]);
  });

  it("rejects multi-party DM creation", async () => {
    const repository: ChannelRepository = {
      listByCompany: vi.fn(),
      getById: vi.fn(),
      findCompanyGeneral: vi.fn(),
      findProjectChannel: vi.fn(),
      create: vi.fn(),
    };

    const service = new ChannelService(repository, {
      listCompanies: vi.fn(),
      listProjects: vi.fn(),
      listCompanyMembers: vi.fn(),
      listCompanyAgents: vi.fn(),
    });

    await expect(
      service.createChannel({
        type: "dm",
        companyId: "company-1",
        name: "Bad DM",
        paperclipRefId: undefined,
        participants: [
          { participantType: "human", participantId: "user-1" },
          { participantType: "agent", participantId: "agent-1" },
        ],
      }),
    ).rejects.toThrow("DM channels require exactly one target participant");
  });
});
