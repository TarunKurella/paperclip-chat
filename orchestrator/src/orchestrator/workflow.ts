import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

export type WorkflowErrorCode =
  | "missing_workflow_file"
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;

  constructor(code: WorkflowErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export interface WorkflowDefinition {
  path: string;
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface WorkflowLoadOptions {
  cwd?: string;
  workflowPath?: string;
}

export interface ResolvedWorkflowConfig {
  workflowPath: string;
  beads: {
    command: string;
    readyArgs: string[];
    showArgs: string[];
    listArgs: string[];
    closedStatuses: string[];
    activeStatuses: string[];
    claimOnDispatch: boolean;
    claimCommandTemplate?: string;
    startCommandTemplate?: string;
    closeCommandTemplate?: string;
    dbPath?: string;
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    afterCreate?: string;
    beforeRun?: string;
    afterRun?: string;
    beforeRemove?: string;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxRetryBackoffMs: number;
    maxTurns: number;
    maxConcurrentAgentsByStatus: Record<string, number>;
  };
  codex: {
    command: string;
    wsUrl?: string;
    approvalPolicy?: string;
    threadSandbox?: string;
    turnSandboxPolicy?: unknown;
    wsConnectTimeoutMs: number;
    turnTimeoutMs: number;
    readTimeoutMs: number;
    stallTimeoutMs: number;
  };
}

const DEFAULT_WORKFLOW_FILE = "WORKFLOW.md";

export async function loadWorkflowDefinition(options: WorkflowLoadOptions = {}): Promise<WorkflowDefinition> {
  const cwd = options.cwd ?? process.cwd();
  const resolvedPath = options.workflowPath
    ? path.resolve(cwd, options.workflowPath)
    : path.resolve(cwd, DEFAULT_WORKFLOW_FILE);

  try {
    await access(resolvedPath);
  } catch (error) {
    throw new WorkflowError(
      "missing_workflow_file",
      `Workflow file not found at ${resolvedPath}`,
      { cause: error },
    );
  }

  const contents = await readFile(resolvedPath, "utf8");
  const { frontMatter, body } = splitFrontMatter(contents);
  const config = parseWorkflowFrontMatter(frontMatter, resolvedPath);

  return {
    path: resolvedPath,
    config,
    promptTemplate: body.trim(),
  };
}

export function resolveWorkflowConfig(
  definition: WorkflowDefinition,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ResolvedWorkflowConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const raw = definition.config;

  const beads = getObject(raw.beads);
  const polling = getObject(raw.polling);
  const workspace = getObject(raw.workspace);
  const hooks = getObject(raw.hooks);
  const agent = getObject(raw.agent);
  const codex = getObject(raw.codex);

  const resolved: ResolvedWorkflowConfig = {
    workflowPath: definition.path,
    beads: {
      command: requireNonEmpty(resolveScalar(beads.command, env), "beads.command"),
      readyArgs: coerceStringArray(beads.ready_args, ["ready", "--json"], env),
      showArgs: coerceStringArray(beads.show_args, ["show", "{{ bead.identifier }}", "--json"], env),
      listArgs: coerceStringArray(beads.list_args, ["list", "--json"], env),
      closedStatuses: coerceStringArray(beads.closed_statuses, ["closed"], env),
      activeStatuses: coerceStringArray(beads.active_statuses, ["open", "in_progress"], env),
      claimOnDispatch: coerceBoolean(beads.claim_on_dispatch, true),
      claimCommandTemplate: optionalNonEmpty(resolveScalar(beads.claim_command_template, env)),
      startCommandTemplate: optionalNonEmpty(resolveScalar(beads.start_command_template, env)),
      closeCommandTemplate: optionalNonEmpty(resolveScalar(beads.close_command_template, env)),
      dbPath: optionalExpandedPath(resolveScalar(beads.db_path, env), cwd, env),
    },
    polling: {
      intervalMs: coerceNumber(polling.interval_ms, 30000, "polling.interval_ms"),
    },
    workspace: {
      root: expandPath(resolveScalar(workspace.root, env) ?? path.join(os.tmpdir(), "symphony_workspaces"), cwd, env),
    },
    hooks: {
      afterCreate: optionalNonEmpty(resolveScalar(hooks.after_create, env)),
      beforeRun: optionalNonEmpty(resolveScalar(hooks.before_run, env)),
      afterRun: optionalNonEmpty(resolveScalar(hooks.after_run, env)),
      beforeRemove: optionalNonEmpty(resolveScalar(hooks.before_remove, env)),
      timeoutMs: coerceNumber(hooks.timeout_ms, 60000, "hooks.timeout_ms"),
    },
    agent: {
      maxConcurrentAgents: coerceNumber(agent.max_concurrent_agents, 10, "agent.max_concurrent_agents"),
      maxRetryBackoffMs: coerceNumber(agent.max_retry_backoff_ms, 300000, "agent.max_retry_backoff_ms"),
      maxTurns: coerceNumber(agent.max_turns, 20, "agent.max_turns"),
      maxConcurrentAgentsByStatus: coerceNumberMap(getObject(agent.max_concurrent_agents_by_status)),
    },
    codex: {
      command: requireNonEmpty(resolveScalar(codex.command, env) ?? "codex app-server", "codex.command"),
      wsUrl: optionalNonEmpty(resolveScalar(codex.ws_url, env)),
      approvalPolicy: optionalNonEmpty(resolveScalar(codex.approval_policy, env)),
      threadSandbox: optionalNonEmpty(resolveScalar(codex.thread_sandbox, env)),
      turnSandboxPolicy: codex.turn_sandbox_policy,
      wsConnectTimeoutMs: coerceNumber(codex.ws_connect_timeout_ms, 30000, "codex.ws_connect_timeout_ms"),
      turnTimeoutMs: coerceNumber(codex.turn_timeout_ms, 3600000, "codex.turn_timeout_ms"),
      readTimeoutMs: coerceNumber(codex.read_timeout_ms, 5000, "codex.read_timeout_ms"),
      stallTimeoutMs: coerceNumber(codex.stall_timeout_ms, 300000, "codex.stall_timeout_ms"),
    },
  };

  return resolved;
}

function splitFrontMatter(contents: string): { frontMatter: string | null; body: string } {
  if (!contents.startsWith("---")) {
    return { frontMatter: null, body: contents };
  }

  const normalized = contents.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return { frontMatter: null, body: contents };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (endIndex === -1) {
    return { frontMatter: null, body: contents };
  }

  return {
    frontMatter: lines.slice(1, endIndex).join("\n"),
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

function parseWorkflowFrontMatter(frontMatter: string | null, workflowPath: string): Record<string, unknown> {
  if (!frontMatter) {
    return {};
  }

  try {
    const parsed = parse(frontMatter);
    if (parsed == null) {
      return {};
    }

    if (!isPlainObject(parsed)) {
      throw new WorkflowError(
        "workflow_front_matter_not_a_map",
        `Workflow front matter in ${workflowPath} must decode to an object`,
      );
    }

    return parsed;
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }

    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to parse workflow front matter in ${workflowPath}`,
      { cause: error },
    );
  }
}

function coerceStringArray(value: unknown, fallback: string[], env: NodeJS.ProcessEnv): string[] {
  if (value == null) {
    return fallback;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => requireNonEmpty(resolveScalar(entry, env), "string array entry"));
  }

  const scalar = resolveScalar(value, env);
  return scalar ? [scalar] : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }

  return fallback;
}

function coerceNumber(value: unknown, fallback: number, field: string): number {
  if (value == null) {
    return fallback;
  }

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new WorkflowError("workflow_parse_error", `Invalid numeric value for ${field}`);
  }

  return numeric;
}

function coerceNumberMap(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).map(([key, rawValue]) => [key, coerceNumber(rawValue, 0, `agent.max_concurrent_agents_by_status.${key}`)]),
  );
}

function resolveScalar(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    return String(value);
  }

  if (value.startsWith("$") && value.length > 1) {
    return env[value.slice(1)] ?? "";
  }

  return value;
}

function expandPath(input: string, cwd: string, env: NodeJS.ProcessEnv): string {
  let expanded = input;
  if (expanded.startsWith("~/")) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  expanded = expanded.replace(/\$([A-Z0-9_]+)/gi, (_, name: string) => env[name] ?? "");
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function optionalExpandedPath(
  input: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return input ? expandPath(input, cwd, env) : undefined;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new WorkflowError("workflow_parse_error", `${field} must be a non-empty string`);
  }

  return trimmed;
}

function getObject(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
