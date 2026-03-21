import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ResolvedWorkflowConfig } from "./workflow.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceRecord {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface HookResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export class WorkspaceManager {
  constructor(
    private readonly config: ResolvedWorkflowConfig["workspace"],
    private readonly hooks: ResolvedWorkflowConfig["hooks"],
  ) {}

  async createForBead(identifier: string): Promise<WorkspaceRecord> {
    const workspaceKey = sanitizeWorkspaceKey(identifier);
    const workspacePath = path.resolve(this.config.root, workspaceKey);

    assertWithinRoot(this.config.root, workspacePath);

    let createdNow = await ensureDirectory(workspacePath);
    if (!createdNow && !(await isHydratedWorkspace(workspacePath))) {
      await this.runBeforeRemove(workspacePath);
      await rm(workspacePath, { recursive: true, force: true });
      await mkdir(workspacePath, { recursive: false });
      createdNow = true;
    }

    const workspace = {
      path: workspacePath,
      workspaceKey,
      createdNow,
    };

    if (createdNow && this.hooks.afterCreate) {
      const result = await runWorkspaceHook(this.hooks.afterCreate, workspace.path, this.hooks.timeoutMs);
      if (!result.ok) {
        throw new Error(`after_create hook failed for ${identifier}: ${result.stderr || result.stdout}`);
      }
    }

    return workspace;
  }

  async runBeforeRun(workspacePath: string): Promise<void> {
    if (!this.hooks.beforeRun) {
      return;
    }

    const result = await runWorkspaceHook(this.hooks.beforeRun, workspacePath, this.hooks.timeoutMs);
    if (!result.ok) {
      throw new Error(`before_run hook failed: ${result.stderr || result.stdout}`);
    }
  }

  async runAfterRun(workspacePath: string): Promise<HookResult | null> {
    if (!this.hooks.afterRun) {
      return null;
    }

    return runWorkspaceHook(this.hooks.afterRun, workspacePath, this.hooks.timeoutMs);
  }

  async runBeforeRemove(workspacePath: string): Promise<HookResult | null> {
    if (!this.hooks.beforeRemove) {
      return null;
    }

    return runWorkspaceHook(this.hooks.beforeRemove, workspacePath, this.hooks.timeoutMs);
  }
}

export function sanitizeWorkspaceKey(identifier: string): string {
  return identifier.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

export async function runWorkspaceHook(
  script: string,
  cwd: string,
  timeoutMs: number,
): Promise<HookResult> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-lc", script], {
      cwd,
      timeout: timeoutMs,
    });

    return {
      ok: true,
      code: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    const cast = error as { code?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      code: cast.code ?? null,
      stdout: cast.stdout ?? "",
      stderr: cast.stderr ?? "",
    };
  }
}

async function ensureDirectory(targetPath: string): Promise<boolean> {
  try {
    await mkdir(targetPath, { recursive: false });
    return true;
  } catch (error) {
    const cast = error as NodeJS.ErrnoException;
    if (cast.code === "EEXIST") {
      return false;
    }

    await mkdir(targetPath, { recursive: true });
    return true;
  }
}

async function isHydratedWorkspace(targetPath: string): Promise<boolean> {
  const gitPath = path.join(targetPath, ".git");
  try {
    await stat(gitPath);
  } catch {
    return false;
  }

  const entries = await readdir(targetPath);
  const meaningfulEntries = entries.filter((entry) => !WORKSPACE_METADATA_ENTRIES.has(entry));
  return meaningfulEntries.length > 0;
}

const WORKSPACE_METADATA_ENTRIES = new Set([
  ".beads",
  ".git",
  ".gitignore",
  ".paperclip-artifacts",
  ".paperclip-notes",
  "AGENTS.md",
]);

function assertWithinRoot(root: string, targetPath: string): void {
  const relative = path.relative(path.resolve(root), targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Workspace path escaped configured root: ${targetPath}`);
  }
}
