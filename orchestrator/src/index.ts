import { APP_NAME } from "@paperclip-chat/shared";
import { setTimeout as delay } from "node:timers/promises";
import { BeadClient } from "./orchestrator/beads.js";
import { Orchestrator } from "./orchestrator/runtime.js";
import {
  loadWorkflowDefinition,
  resolveWorkflowConfig,
} from "./orchestrator/workflow.js";
import { WorkspaceManager } from "./orchestrator/workspace.js";

export async function bootstrapOrchestrator(cwd = process.cwd()): Promise<string> {
  const workflow = await loadWorkflowDefinition({ cwd });
  const config = resolveWorkflowConfig(workflow, { cwd });
  const beadClient = new BeadClient(config.beads, cwd);
  const workspaceManager = new WorkspaceManager(config.workspace, config.hooks);
  const orchestrator = new Orchestrator(workflow, config, beadClient, workspaceManager);
  const snapshot = await orchestrator.tick();

  return `${APP_NAME} orchestrator (${config.beads.command}, ${config.polling.intervalMs}ms, running=${snapshot.running.length})`;
}

export async function runOrchestratorService(cwd = process.cwd()): Promise<void> {
  const workflow = await loadWorkflowDefinition({ cwd });
  const config = resolveWorkflowConfig(workflow, { cwd });
  const beadClient = new BeadClient(config.beads, cwd);
  const workspaceManager = new WorkspaceManager(config.workspace, config.hooks);
  const orchestrator = new Orchestrator(workflow, config, beadClient, workspaceManager);
  let stopping = false;

  const stop = () => {
    stopping = true;
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    while (!stopping) {
      const snapshot = await orchestrator.tick();
      console.log(
        `${APP_NAME} orchestrator (${config.beads.command}, ${config.polling.intervalMs}ms, running=${snapshot.running.length}, retrying=${snapshot.retrying.length})`,
      );

      if (stopping) {
        break;
      }

      await delay(config.polling.intervalMs);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runOrchestratorService();
}
