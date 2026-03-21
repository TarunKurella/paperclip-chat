import { useState, startTransition } from "react";
import { useQuery } from "@tanstack/react-query";
import { APP_NAME, CHAT_API_PATHS, type Channel, type Notification } from "@paperclip-chat/shared";
import {
  BellRing,
  ChevronRight,
  MessageSquareText,
  Radio,
  Sparkles,
  TriangleAlert,
} from "lucide-react";

export function App() {
  const companyId = readCompanyId();
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: async () => requestJson<{ status: string; paperclip: string; ws: string }>("/api/health"),
  });
  const channelsQuery = useQuery({
    queryKey: ["channels", companyId],
    enabled: Boolean(companyId),
    queryFn: async () =>
      requestJson<Channel[]>(
        `${CHAT_API_PATHS.CHANNELS}?companyId=${encodeURIComponent(companyId!)}`,
      ),
  });
  const notificationsQuery = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => requestJson<{ notifications: Notification[] }>(CHAT_API_PATHS.NOTIFICATIONS),
    retry: false,
  });

  const channels = channelsQuery.data ?? demoChannels;
  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ??
    channels[0] ??
    null;
  const notifications = notificationsQuery.data?.notifications ?? demoNotifications;
  const usingFallbackChannels = !companyId || channelsQuery.isError || channels.length === 0;
  const unauthenticatedNotifications = notificationsQuery.isError;

  return (
    <main className="min-h-screen bg-stone-100 text-neutral-950">
      <div className="mx-auto flex min-h-screen max-w-[1600px] flex-col px-4 py-4 lg:px-6">
        <header className="mb-4 rounded-[28px] border border-stone-200 bg-white/95 px-5 py-4 shadow-[0_1px_0_rgba(0,0,0,0.04)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div className="rounded-2xl border border-stone-200 bg-stone-100 p-3">
                <MessageSquareText className="h-6 w-6" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-stone-500">
                  Paperclip Chat
                </p>
                <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-sm text-stone-600">
              <StatusPill
                label="Server"
                value={healthQuery.data?.status ?? "loading"}
                tone={healthQuery.data?.status === "ok" ? "green" : "amber"}
              />
              <StatusPill
                label="Paperclip"
                value={healthQuery.data?.paperclip ?? "pending"}
                tone={healthQuery.data?.paperclip === "connected" ? "green" : "amber"}
              />
              <StatusPill
                label="Realtime"
                value={healthQuery.data?.ws ?? "pending"}
                tone={healthQuery.data?.ws === "running" ? "green" : "amber"}
              />
              <div className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-600">
                {companyId ? `companyId ${companyId.slice(0, 8)}…` : "Add ?companyId=<uuid> for live channels"}
              </div>
            </div>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)_320px]">
          <aside className="rounded-[28px] border border-stone-200 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]">
            <div className="border-b border-stone-200 px-5 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                    Channels
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">Conversation Surface</h2>
                </div>
                <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
                  {channels.length}
                </span>
              </div>
              {usingFallbackChannels ? (
                <p className="mt-3 text-sm leading-6 text-stone-500">
                  Showing local preview channels until a live company context is available.
                </p>
              ) : null}
            </div>
            <div className="space-y-1 px-3 py-3">
              {channels.map((channel) => {
                const selected = channel.id === selectedChannel?.id;
                return (
                  <button
                    key={channel.id}
                    type="button"
                    onClick={() =>
                      startTransition(() => {
                        setSelectedChannelId(channel.id);
                      })
                    }
                    className={[
                      "flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition",
                      selected ? "bg-stone-100" : "hover:bg-stone-50",
                    ].join(" ")}
                  >
                    <div className="mt-1 h-2.5 w-2.5 rounded-full bg-blue-500" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-semibold text-stone-900">{channel.name}</p>
                        <ChevronRight className="h-4 w-4 shrink-0 text-stone-400" />
                      </div>
                      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                        {channel.type.replace("_", " ")}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="flex min-h-[640px] flex-col rounded-[28px] border border-stone-200 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]">
            <div className="border-b border-stone-200 px-6 py-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                    Active Thread
                  </p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-tight">
                    {selectedChannel?.name ?? "No channel selected"}
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
                    Transcript-style chat surface aligned with Paperclip’s run and inbox patterns.
                    Session send/history routes are live; subprocess and agent presence wiring are next.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs font-medium text-stone-500">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  Live shell
                </div>
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
              {buildThreadPreview(selectedChannel).map((entry) => (
                <article key={entry.id} className="rounded-3xl border border-stone-200 bg-stone-50/70 px-4 py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={[
                          "h-2.5 w-2.5 rounded-full",
                          entry.kind === "agent" ? "bg-emerald-500" : "bg-stone-400",
                        ].join(" ")}
                      />
                      <p className="text-sm font-semibold text-stone-900">{entry.author}</p>
                      <span className="text-xs uppercase tracking-[0.16em] text-stone-500">{entry.kind}</span>
                    </div>
                    <span className="text-xs text-stone-500">{entry.timestamp}</span>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-stone-700">{entry.body}</p>
                </article>
              ))}
            </div>

            <div className="border-t border-stone-200 px-6 py-5">
              <div className="rounded-[24px] border border-stone-200 bg-stone-50 px-4 py-4">
                <div className="flex items-center gap-2 text-sm font-medium text-stone-700">
                  <Radio className="h-4 w-4 text-blue-500" />
                  Composer wiring is next
                </div>
                <p className="mt-2 text-sm leading-6 text-stone-500">
                  The backend session send route is live. This shell is ready for the next slice:
                  composing a message, listing real turns, and subscribing to session updates.
                </p>
              </div>
            </div>
          </section>

          <aside className="rounded-[28px] border border-stone-200 bg-white shadow-[0_1px_0_rgba(0,0,0,0.04)]">
            <div className="border-b border-stone-200 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-amber-50 p-2 text-amber-600">
                  <BellRing className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">
                    Notifications
                  </p>
                  <h2 className="text-lg font-semibold">Unread Queue</h2>
                </div>
              </div>
              {unauthenticatedNotifications ? (
                <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>Showing preview notifications until a Paperclip-authenticated browser session is present.</p>
                </div>
              ) : null}
            </div>
            <div className="space-y-3 px-4 py-4">
              {notifications.map((notification) => (
                <article key={notification.id} className="rounded-2xl border border-stone-200 bg-stone-50 px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-stone-900">{renderNotificationTitle(notification)}</p>
                      <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">
                        {notification.type.replace("_", " ")}
                      </p>
                    </div>
                    <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                  </div>
                  <p className="mt-3 text-sm leading-6 text-stone-600">
                    {renderNotificationBody(notification)}
                  </p>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function StatusPill(props: { label: string; value: string; tone: "green" | "amber" }) {
  const toneClass = props.tone === "green" ? "bg-emerald-500" : "bg-amber-500";

  return (
    <div className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5">
      <span className={["h-2 w-2 rounded-full", toneClass].join(" ")} />
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">{props.label}</span>
      <span className="text-sm font-medium text-stone-700">{props.value}</span>
    </div>
  );
}

function buildThreadPreview(channel: Channel | null) {
  if (!channel) {
    return [];
  }

  return [
    {
      id: `${channel.id}-1`,
      author: "Operator",
      kind: "human",
      timestamp: "just now",
      body: `Opened ${channel.name} and prepared the chat surface for live session traffic.`,
    },
    {
      id: `${channel.id}-2`,
      author: "paperclip-chat",
      kind: "agent",
      timestamp: "live",
      body: "Session routes, token counting, history pagination, and notifications are now wired. Composer send and realtime thread hydration are next.",
    },
  ];
}

function renderNotificationTitle(notification: Notification) {
  switch (notification.type) {
    case "agent_initiated":
      return "Agent initiated a new thread";
    case "decision_pending":
      return "Decision ready for review";
    default:
      return "Unread conversation update";
  }
}

function renderNotificationBody(notification: Notification) {
  const payload = notification.payload as Record<string, string | undefined>;
  if (payload.turnId) {
    return `Turn ${payload.turnId} is waiting in channel ${payload.channelId ?? "unknown"}.`;
  }

  return "A new update is waiting in the chat queue.";
}

function readCompanyId() {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("companyId");
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

const demoChannels: Channel[] = [
  {
    id: "demo-general",
    type: "company_general",
    companyId: "demo-company",
    paperclipRefId: null,
    name: "Company General",
  },
  {
    id: "demo-project",
    type: "project",
    companyId: "demo-company",
    paperclipRefId: null,
    name: "Auth Refactor",
  },
  {
    id: "demo-dm",
    type: "dm",
    companyId: "demo-company",
    paperclipRefId: null,
    name: "CEO Direct",
  },
];

const demoNotifications: Notification[] = [
  {
    id: "demo-notification-1",
    userId: "demo-user",
    companyId: "demo-company",
    type: "agent_initiated",
    payload: { channelId: "demo-general", turnId: "demo-turn-1" },
    readAt: null,
    createdAt: new Date("2026-03-21T12:00:00.000Z").toISOString(),
  },
  {
    id: "demo-notification-2",
    userId: "demo-user",
    companyId: "demo-company",
    type: "unread_message",
    payload: { channelId: "demo-project", turnId: "demo-turn-2" },
    readAt: null,
    createdAt: new Date("2026-03-21T11:40:00.000Z").toISOString(),
  },
];
