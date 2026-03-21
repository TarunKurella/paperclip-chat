import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedWorkflowConfig } from "./workflow.js";

const execFileAsync = promisify(execFile);

export interface NormalizedDependencyRef {
  id: string | null;
  identifier: string | null;
  status: string | null;
}

export interface NormalizedBead {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  status: string;
  assignee: string | null;
  labels: string[];
  dependsOn: NormalizedDependencyRef[];
  createdAt: string | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
}

export class BeadClient {
  constructor(
    private readonly config: ResolvedWorkflowConfig["beads"],
    private readonly cwd = process.cwd(),
  ) {}

  async fetchReadyBeads(): Promise<NormalizedBead[]> {
    const output = await this.runJsonCommand(this.config.readyArgs);
    return normalizeBeadCollection(output);
  }

  async fetchBeadsByStatus(statuses: string[]): Promise<NormalizedBead[]> {
    const output = await this.runJsonCommand(this.config.listArgs);
    const active = new Set(statuses.map((status) => status.toLowerCase()));
    return normalizeBeadCollection(output).filter((bead) => active.has(bead.status));
  }

  async fetchBeadStatesByIdsOrIdentifiers(refs: string[]): Promise<NormalizedBead[]> {
    const results = await Promise.all(refs.map((ref) => this.runJsonCommand([...this.interpolateShowArgs(ref)])));
    return results.flatMap((result) => normalizeBeadCollection(result));
  }

  private interpolateShowArgs(ref: string): string[] {
    return this.config.showArgs.map((arg) => arg.replaceAll("{{ bead.identifier }}", ref));
  }

  private async runJsonCommand(args: string[]): Promise<unknown> {
    const stdout = await runBeadsCommand(this.config.command, args, this.cwd);
    return parseJsonPayload(stdout);
  }
}

export async function runBeadsCommand(command: string, args: string[], cwd: string): Promise<string> {
  if (/\s/.test(command.trim())) {
    const shellCommand = [command, ...args.map(shellEscape)].join(" ");
    const { stdout } = await execFileAsync("sh", ["-lc", shellCommand], { cwd });
    return stdout;
  }

  const { stdout } = await execFileAsync(command, args, { cwd });
  return stdout;
}

export function normalizeBeadCollection(payload: unknown): NormalizedBead[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeBead);
  }

  if (payload && typeof payload === "object") {
    return [normalizeBead(payload)];
  }

  return [];
}

function normalizeBead(input: unknown): NormalizedBead {
  const raw = isPlainObject(input) ? input : {};
  const id = asString(raw.id) ?? asString(raw.identifier);
  if (!id) {
    throw new Error("bd payload is missing id/identifier");
  }

  const identifier = asString(raw.identifier) ?? id;
  const dependencySource = Array.isArray(raw.dependencies) ? raw.dependencies : [];

  return {
    id,
    identifier,
    title: asString(raw.title) ?? identifier,
    description: asNullableString(raw.description),
    priority: asNullableNumber(raw.priority),
    status: (asString(raw.status) ?? "open").toLowerCase(),
    assignee: asNullableString(raw.assignee),
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => String(label).toLowerCase())
      : [],
    dependsOn: dependencySource.map((dependency) => normalizeDependency(dependency)),
    createdAt: asNullableString(raw.created_at),
    updatedAt: asNullableString(raw.updated_at),
    raw,
  };
}

function normalizeDependency(input: unknown): NormalizedDependencyRef {
  const raw = isPlainObject(input) ? input : {};
  return {
    id: asNullableString(raw.id),
    identifier: asNullableString(raw.identifier),
    status: asNullableString(raw.status),
  };
}

function parseJsonPayload(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  return JSON.parse(trimmed);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
