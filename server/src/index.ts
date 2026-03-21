import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PaperclipWsSubscription } from "./adapters/paperclipWs.js";
import { PaperclipClient } from "./adapters/paperclipClient.js";
import { createAuthenticateMiddleware, requireAnyMiddleware, requireHumanMiddleware, requireHumanOrServiceMiddleware } from "./auth/express.js";
import { readServiceAccountEnv, startServiceAccountLifecycle, stopServiceAccountLifecycle } from "./auth/serviceAccount.js";
import { channelRoutes } from "./channels/routes.js";
import { ChannelService } from "./channels/service.js";
import { DbChannelRepository } from "./channels/repository.js";
import { InMemoryChannelRepository } from "./channels/memoryRepository.js";
import { createServerDatabase } from "./db/client.js";
import { ChatWsHub } from "./ws/hub.js";

export interface ServerRuntime {
  app: Express;
  server: HttpServer;
  close(): Promise<void>;
}

export async function bootstrapServer(envSource: NodeJS.ProcessEnv = process.env): Promise<ServerRuntime> {
  const env = readServiceAccountEnv(envSource);
  const paperclipClient = new PaperclipClient({
    baseUrl: env.paperclipApiUrl,
    serviceKey: env.chatServiceKey,
  });
  const lifecycle = await startServiceAccountLifecycle(env);

  const database = envSource.DATABASE_URL ? createServerDatabase(envSource) : null;
  if (database) {
    await migrate(database.db, {
      migrationsFolder: path.resolve(process.cwd(), "packages/db/drizzle"),
    });
  }

  const channelRepository = database ? new DbChannelRepository(database.db) : new InMemoryChannelRepository();
  const channelService = new ChannelService(channelRepository, paperclipClient);
  await channelService.seedChannels();

  const paperclipCompanies = await paperclipClient.listCompanies();
  const wsSubscriptions = paperclipCompanies.map((company) => {
    const subscription = new PaperclipWsSubscription({
      baseUrl: env.paperclipApiUrl,
      companyId: company.id,
      serviceKey: env.chatServiceKey,
    });
    subscription.start();
    return subscription;
  });

  const app = express();
  app.use(express.json());

  const authenticateMiddleware = createAuthenticateMiddleware(paperclipClient, envSource);
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", paperclip: "connected", ws: "running" });
  });
  app.use(
    "/api",
    channelRoutes(channelService, {
      authenticate: authenticateMiddleware,
      requireAny: requireAnyMiddleware,
      requireHumanOrService: requireHumanOrServiceMiddleware,
    }),
  );
  app.use("/api/notifications", authenticateMiddleware, requireHumanMiddleware, notImplementedRouter("notifications"));
  app.use("/api/sessions", authenticateMiddleware, requireAnyMiddleware, notImplementedRouter("sessions"));

  const server = createServer(app);
  const hub = new ChatWsHub(paperclipClient, envSource);
  hub.attach(server);

  const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
  app.use(express.static(staticDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  const close = async () => {
    hub.close();
    wsSubscriptions.forEach((subscription) => subscription.stop());
    stopServiceAccountLifecycle(lifecycle);
    if (database) {
      await database.close();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  };

  const shutdown = () => {
    void close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return {
    app,
    server,
    close,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runtime = await bootstrapServer();
  const port = Number(process.env.PORT ?? 4000);
  runtime.server.listen(port, () => {
    console.log(`paperclip-chat server listening on http://127.0.0.1:${port}`);
  });
}

function notImplementedRouter(resource: string): Express {
  const app = express();
  app.use((_req, res) => {
    res.status(501).json({ error: `${resource} routes not implemented yet` });
  });
  return app;
}
