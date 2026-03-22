import { createServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { CHAT_EVENT_TYPES, type Turn } from "@paperclip-chat/shared";
import { PaperclipWsSubscription } from "./adapters/paperclipWs.js";
import { PaperclipClient } from "./adapters/paperclipClient.js";
import { createAuthenticateMiddleware, requireAnyMiddleware, requireHumanMiddleware, requireHumanOrServiceMiddleware } from "./auth/express.js";
import { readServiceAccountEnv, startServiceAccountLifecycle, stopServiceAccountLifecycle } from "./auth/serviceAccount.js";
import { channelRoutes } from "./channels/routes.js";
import { ChannelService } from "./channels/service.js";
import { DbChannelRepository } from "./channels/repository.js";
import { InMemoryChannelRepository } from "./channels/memoryRepository.js";
import { createDrizzleTrunkStore, TrunkManager, type TrunkStore } from "./context/TrunkManager.js";
import { createServerDatabase } from "./db/client.js";
import { notificationRoutes } from "./notifications/routes.js";
import { skillRoutes } from "./skills/routes.js";
import { DebounceBuffer } from "./session/Debounce.js";
import { IdleSessionCoordinator } from "./session/IdleSessionCoordinator.js";
import { InMemorySessionRepository } from "./session/memoryRepository.js";
import { DbSessionRepository } from "./session/repository.js";
import { SessionManager, type NotificationRepository, type SessionRepository } from "./session/SessionManager.js";
import { sessionRoutes } from "./session/routes.js";
import { AgentDispatchCoordinator } from "./subprocess/AgentDispatchCoordinator.js";
import { PresenceStateMachine } from "./subprocess/PresenceStateMachine.js";
import { resolveChatWorkspace } from "./subprocess/WorkspaceResolver.js";
import { runLocalAgentCli } from "./subprocess/runLocalAgentCli.js";
import { SubprocessManager } from "./subprocess/SubprocessManager.js";
import { WakeupScaffoldManager } from "./wakeup/WakeupScaffoldManager.js";
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
  let sessionRepository: SessionRepository & NotificationRepository;
  let trunkStore: TrunkStore;
  if (database) {
    const dbSessionRepository = new DbSessionRepository(database.db);
    sessionRepository = dbSessionRepository;
    trunkStore = createDrizzleTrunkStore(database.db);
  } else {
    const inMemorySessionRepository = new InMemorySessionRepository();
    sessionRepository = inMemorySessionRepository;
    trunkStore = inMemorySessionRepository;
  }
  const channelService = new ChannelService(channelRepository, paperclipClient);
  await channelService.seedChannels();

  const paperclipCompanies = await paperclipClient.listCompanies();
  const wsSubscriptions = paperclipCompanies.map((company) => {
    const subscription = new PaperclipWsSubscription({
      baseUrl: env.paperclipApiUrl,
      companyId: company.id,
      serviceKey: lifecycle.serviceAccount?.liveEventsToken ?? env.chatServiceKey,
      onAgentStatus: (event) => {
        presence.updateFromPaperclip(event.agentId, event.status);
        hub.broadcastToCompany(company.id, {
          type: CHAT_EVENT_TYPES.AGENT_STATUS,
          payload: event,
        });
      },
      onRunLog: (event) => {
        hub.broadcastToCompany(company.id, {
          type: CHAT_EVENT_TYPES.AGENT_RUN_LOG,
          payload: event,
        });
      },
    });
    subscription.start();
    return subscription;
  });

  const app = express();
  app.use(express.json());

  const authenticateMiddleware = createAuthenticateMiddleware(paperclipClient, envSource);
  const server = createServer(app);
  const hub = new ChatWsHub(paperclipClient, envSource);
  hub.attach(server);
  const wakeupManager = new WakeupScaffoldManager(paperclipClient, sessionRepository);
  let dispatchCoordinator: AgentDispatchCoordinator | null = null;
  const presence = new PresenceStateMachine({
    flush: (agentId) => {
      void dispatchCoordinator?.flushPending(agentId);
    },
  });
  const subprocessManager = new SubprocessManager(
    presence,
    (channel, agentId, sessionId) => resolveChatWorkspace(channel, agentId, sessionId, paperclipClient),
    (input) => runLocalAgentCli(input, envSource),
    sessionRepository,
    hub,
    envSource,
  );
  dispatchCoordinator = new AgentDispatchCoordinator(
    sessionRepository,
    channelService,
    paperclipClient,
    subprocessManager,
    wakeupManager,
  );
  const debounce = new DebounceBuffer<Turn>(async (agentId, sessionId, turns) => {
    await dispatchCoordinator?.flush(agentId, sessionId, turns);
  });
  const sessionManager = new SessionManager(
    new TrunkManager(trunkStore),
    sessionRepository,
    hub,
    sessionRepository,
    debounce,
    { enqueue: async () => {} },
    paperclipClient,
  );
  const idleSessionCoordinator = new IdleSessionCoordinator(
    sessionManager,
    Number(envSource.CHAT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000),
  );
  hub.setReplayProvider((sessionId, lastSeq) => sessionManager.listMessages(sessionId, lastSeq));
  const recoveredSessions = await sessionManager.recoverActiveSessions();
  await Promise.all(
    recoveredSessions.map(async ({ session }) => {
      idleSessionCoordinator.track(session.id);
      const channel = await channelService.getChannel(session.channelId);
      if (!channel) {
        return;
      }

      await wakeupManager.recoverSessionScaffolds(session, channel);
    }),
  );
  wsSubscriptions.forEach((subscription) => {
    const snapshot = subscription.presence.snapshot();
    for (const [agentId, record] of Object.entries(snapshot)) {
      presence.updateFromPaperclip(agentId, record.status);
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", paperclip: "connected", ws: "running" });
  });
  app.use("/api", skillRoutes());
  app.use(
    "/api",
    channelRoutes(channelService, {
      authenticate: authenticateMiddleware,
      requireAny: requireAnyMiddleware,
      requireHumanOrService: requireHumanOrServiceMiddleware,
    }),
  );
  app.use(
    "/api",
    sessionRoutes(sessionManager, {
      authenticate: authenticateMiddleware,
      requireAny: requireAnyMiddleware,
    }, {
      onSessionOpened: async (session) => {
        idleSessionCoordinator.track(session.id);
        const channel = await channelService.getChannel(session.channelId);
        if (!channel) {
          return;
        }

        const participants = await sessionManager.listSessionParticipants(session.id);
        await Promise.all(
          participants
            .filter((participant) => participant.participantType === "agent")
            .map((participant) => wakeupManager.ensureSessionScaffold(session, channel, participant.participantId)),
        );
      },
      onTurnProcessed: async (sessionId) => {
        idleSessionCoordinator.touch(sessionId);
      },
      onSessionClosed: async (sessionId) => {
        idleSessionCoordinator.untrack(sessionId);
      },
    }),
  );
  app.use(
    "/api",
    notificationRoutes(sessionManager, {
      authenticate: authenticateMiddleware,
      requireHuman: requireHumanMiddleware,
    }),
  );

  const staticDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui/dist");
  app.use(express.static(staticDir));
  app.get("/", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  const close = async () => {
    debounce.close();
    idleSessionCoordinator.close();
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
