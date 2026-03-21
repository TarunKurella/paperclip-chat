import { APP_NAME } from "@paperclip-chat/shared";
import { readServiceAccountEnv, startServiceAccountLifecycle, stopServiceAccountLifecycle } from "./auth/serviceAccount.js";

export async function bootstrapServer(): Promise<string> {
  const env = readServiceAccountEnv(process.env);
  const lifecycle = await startServiceAccountLifecycle(env);

  const shutdown = () => stopServiceAccountLifecycle(lifecycle);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const serviceAccountName = lifecycle.serviceAccount?.name ?? `${APP_NAME}-server`;
  return `Service account validated: ${serviceAccountName}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const message = await bootstrapServer();
  console.log(message);
}
