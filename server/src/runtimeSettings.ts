import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveManagedCodexHomeDir, resolveSharedCodexHomeDir } from "./subprocess/codexHome.js";
import { resolveAgentInstructionsFilePath } from "./subprocess/runLocalAgentCli.js";

export interface RuntimeSettings {
  paperclipApiUrl: string | null;
  paperclipHome: string | null;
  codexHome: string | null;
  agentInstructionsFile: string | null;
}

export interface RuntimeSettingsSnapshot {
  settings: RuntimeSettings;
  resolved: {
    paperclipApiUrl: string;
    paperclipHome: string;
    codexHome: string;
    managedCodexHome: string;
    agentInstructionsFile: string | null;
    instructionsPathTemplate: string;
  };
  agents: Array<{
    agentId: string;
    companyId: string | null;
    instructionsFilePath: string | null;
  }>;
}

const DEFAULT_SETTINGS_FILE = ".paperclip-chat-runtime.json";

export class RuntimeSettingsStore {
  constructor(
    private readonly envSource: NodeJS.ProcessEnv = process.env,
    private readonly settingsFilePath: string = path.join(process.cwd(), DEFAULT_SETTINGS_FILE),
  ) {}

  async readSettings(): Promise<RuntimeSettings> {
    try {
      const raw = await readFile(this.settingsFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
      return normalizeSettings(parsed);
    } catch {
      return normalizeSettings({});
    }
  }

  async updateSettings(input: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const current = await this.readSettings();
    const next = normalizeSettings({ ...current, ...input });
    await mkdir(path.dirname(this.settingsFilePath), { recursive: true });
    await writeFile(this.settingsFilePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  async buildSnapshot(input?: {
    companyId?: string | null;
    agentIds?: string[];
  }): Promise<RuntimeSettingsSnapshot> {
    const settings = await this.readSettings();
    const resolvedEnv = await this.resolveEnv(settings);
    const companyId = input?.companyId?.trim() || null;
    const agents = await Promise.all(
      (input?.agentIds ?? []).map(async (agentId) => ({
        agentId,
        companyId,
        instructionsFilePath: companyId
          ? await resolveAgentInstructionsFilePath(
              { PAPERCLIP_AGENT_ID: agentId, PAPERCLIP_COMPANY_ID: companyId },
              resolvedEnv,
            )
          : null,
      })),
    );

    return {
      settings,
      resolved: {
        paperclipApiUrl: resolvedEnv.PAPERCLIP_API_URL?.trim() || "",
        paperclipHome: resolvedEnv.PAPERCLIP_HOME?.trim() || path.join(os.homedir(), ".paperclip"),
        codexHome: resolveSharedCodexHomeDir(resolvedEnv),
        managedCodexHome: resolveManagedCodexHomeDir(resolvedEnv, companyId || "company"),
        agentInstructionsFile: settings.agentInstructionsFile?.trim() || null,
        instructionsPathTemplate: path.join(
          resolvedEnv.HOME ?? os.homedir(),
          ".paperclip",
          "instances",
          "default",
          "companies",
          "<companyId>",
          "agents",
          "<agentId>",
          "instructions",
          "AGENTS.md",
        ),
      },
      agents,
    };
  }

  async resolveEnv(): Promise<NodeJS.ProcessEnv>;
  async resolveEnv(settings: RuntimeSettings): Promise<NodeJS.ProcessEnv>;
  async resolveEnv(settings?: RuntimeSettings): Promise<NodeJS.ProcessEnv> {
    const current = settings ?? await this.readSettings();
    return {
      ...this.envSource,
      ...(current.paperclipApiUrl ? { PAPERCLIP_API_URL: current.paperclipApiUrl } : {}),
      ...(current.paperclipHome ? { PAPERCLIP_HOME: current.paperclipHome } : {}),
      ...(current.codexHome ? { CODEX_HOME: current.codexHome } : {}),
      ...(current.agentInstructionsFile ? { CHAT_AGENT_INSTRUCTIONS_FILE: current.agentInstructionsFile } : {}),
    };
  }
}

function normalizeSettings(input: Partial<RuntimeSettings>): RuntimeSettings {
  return {
    paperclipApiUrl: normalizeNullable(input.paperclipApiUrl),
    paperclipHome: normalizeNullable(input.paperclipHome),
    codexHome: normalizeNullable(input.codexHome),
    agentInstructionsFile: normalizeNullable(input.agentInstructionsFile),
  };
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
