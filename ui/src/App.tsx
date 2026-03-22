import { useEffect, useState, startTransition } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { APP_NAME, CHAT_API_PATHS, type AgentChannelState, type Channel, type ChatSession, type Notification, type SessionParticipant, type SessionSummary, type Turn } from "@paperclip-chat/shared";
import { cn } from "./lib/utils.js";
import { Routes, Route, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ChatThread, type AgentPresence, type ThreadEntry } from "./components/ChatThread.js";
import { CrystallizeCard } from "./components/CrystallizeCard.js";
import { MessageInput, type MentionCandidate } from "./components/MessageInput.js";
import { NotificationPanel } from "./components/NotificationPanel.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusPill } from "./components/StatusPill.js";
import { useChatWebSocket } from "./hooks/useChatWebSocket.js";
import { PanelLeft, PanelRight, Lock, X } from "lucide-react";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Shell />} />
      <Route path="/channels/:channelId" element={<Shell />} />
      <Route path="/notifications" element={<Shell />} />
    </Routes>
  );
}

function Shell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const companyId = readCompanyId();
  const [draft, setDraft] = useState("");
  const [liveDecision, setLiveDecision] = useState<ThreadEntry | null>(null);
  const [presenceByAgent, setPresenceByAgent] = useState<Record<string, { status: string; updatedAt: string }>>({});
  const [streamingEntry, setStreamingEntry] = useState<ThreadEntry | null>(null);
  const [typingAgents, setTypingAgents] = useState<string[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<Record<string, ThreadEntry[]>>({});
  const [sessionIdsByChannel, setSessionIdsByChannel] = useState<Record<string, string>>({});
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileActivityOpen, setMobileActivityOpen] = useState(false);
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newDmParticipantId, setNewDmParticipantId] = useState<string | null>(null);
  const [visibleEntryCount, setVisibleEntryCount] = useState(20);
  const [crystallizedIssueId, setCrystallizedIssueId] = useState<string | null>(null);
  const [crystallizeConfirmOpen, setCrystallizeConfirmOpen] = useState(false);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
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
  const markNotificationsReadMutation = useMutation({
    mutationFn: async (notificationIds?: string[]) =>
      requestVoid(CHAT_API_PATHS.NOTIFICATIONS_READ, {
        method: "POST",
        body: JSON.stringify(notificationIds?.length ? { notificationIds } : {}),
      }),
    onSuccess: (_result, notificationIds) => {
      queryClient.setQueryData<{ notifications: Notification[] }>(["notifications"], (current) => {
        const existing = current?.notifications ?? [];
        if (!notificationIds?.length) {
          return { notifications: [] };
        }

        const cleared = new Set(notificationIds);
        return {
          notifications: existing.filter((notification) => !cleared.has(notification.id)),
        };
      });
    },
  });

  const channels = channelsQuery.data ?? demoChannels;
  const selectedChannelId = params.channelId ?? null;
  const selectedChannel =
    channels.find((channel) => channel.id === selectedChannelId) ??
    null;
  const selectedSessionId = selectedChannel ? sessionIdsByChannel[selectedChannel.id] ?? null : null;
  const notifications = notificationsQuery.data?.notifications ?? demoNotifications;
  const notificationsRoute = location.pathname === "/notifications";
  const usingFallbackChannels = !companyId || channelsQuery.isError || channels.length === 0;
  const unauthenticatedNotifications = notificationsQuery.isError;
  const unreadCountByChannel = notifications.reduce<Record<string, number>>((acc, notification) => {
    const channelId = typeof notification.payload.channelId === "string" ? notification.payload.channelId : null;
    if (!channelId) {
      return acc;
    }

    acc[channelId] = (acc[channelId] ?? 0) + 1;
    return acc;
  }, {});
  const openSessionMutation = useMutation({
    mutationFn: async (channel: Channel) =>
      requestJson<{ session: { id: string } }>(CHAT_API_PATHS.SESSIONS, {
        method: "POST",
        body: JSON.stringify({
          channelId: channel.id,
          participantIds: [],
        }),
      }),
    onSuccess: (result, channel) => {
      setSessionIdsByChannel((current) => ({
        ...current,
        [channel.id]: result.session.id,
      }));
    },
  });
  const createDmMutation = useMutation({
    mutationFn: async (input: { companyId: string; participant: SessionParticipant }) =>
      requestJson<Channel>(CHAT_API_PATHS.CHANNELS, {
        method: "POST",
        body: JSON.stringify({
          type: "dm",
          companyId: input.companyId,
          name: input.participant.displayName ?? input.participant.mentionLabel ?? "Direct message",
          participants: [
            {
              participantType: input.participant.participantType,
              participantId: input.participant.participantId,
            },
          ],
        }),
      }),
    onSuccess: (channel) => {
      queryClient.setQueryData<Channel[]>(["channels", companyId], (current) => {
        const existing = current ?? [];
        return existing.some((entry) => entry.id === channel.id) ? existing : [...existing, channel];
      });
      setNewDmOpen(false);
      setNewDmParticipantId(null);
      startTransition(() => {
        navigate(`/channels/${channel.id}${location.search}`);
      });
    },
  });
  const sendMessageMutation = useMutation({
    mutationFn: async (input: { sessionId: string; channelId: string; text: string; mentionedIds: string[] }) =>
      requestJson<{ turn: Turn }>(CHAT_API_PATHS.SESSION_SEND(input.sessionId), {
        method: "POST",
        body: JSON.stringify({
          text: input.text,
          mentionedIds: input.mentionedIds,
        }),
      }),
    onSuccess: (result, variables) => {
      setOptimisticMessages((current) => ({
        ...current,
        [variables.channelId]: [],
      }));
      queryClient.setQueryData<{ turns: Turn[] }>(
        ["messages", variables.channelId, variables.sessionId],
        (current) => ({
          turns: dedupeTurns([...(current?.turns ?? []), result.turn]),
        }),
      );
    },
  });
  const sessionStateQuery = useQuery({
    queryKey: ["session", selectedSessionId],
    enabled: Boolean(selectedSessionId),
    queryFn: async () =>
      requestJson<{ session: ChatSession; agentStates: AgentChannelState[]; summary: SessionSummary | null }>(
        CHAT_API_PATHS.SESSION(selectedSessionId!),
      ),
  });
  const closeSessionMutation = useMutation({
    mutationFn: async (input: { sessionId: string; crystallize?: boolean }) =>
      requestJson<{ session: ChatSession; paperclipIssueId?: string }>(CHAT_API_PATHS.SESSION_CLOSE(input.sessionId), {
        method: "POST",
        body: JSON.stringify({ crystallize: input.crystallize ?? false }),
      }),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<{ session: ChatSession; agentStates: AgentChannelState[]; summary: SessionSummary | null }>(
        ["session", variables.sessionId],
        (current) => ({
          session: result.session,
          agentStates: current?.agentStates ?? [],
          summary: current?.summary ?? null,
        }),
      );
      setCrystallizedIssueId(result.paperclipIssueId ?? null);
    },
  });
  const messagesQuery = useQuery({
    queryKey: ["messages", selectedChannel?.id, selectedSessionId],
    enabled: Boolean(selectedChannel && selectedSessionId),
    queryFn: async () =>
      requestJson<{ turns: Turn[] }>(
        `${CHAT_API_PATHS.CHANNEL_MESSAGES(selectedChannel!.id)}?sessionId=${encodeURIComponent(selectedSessionId!)}`,
      ),
  });
  const loadOlderMessagesMutation = useMutation({
    mutationFn: async (input: { channelId: string; sessionId: string; before: number }) =>
      requestJson<{ turns: Turn[] }>(
        `${CHAT_API_PATHS.CHANNEL_MESSAGES(input.channelId)}?sessionId=${encodeURIComponent(input.sessionId)}&before=${encodeURIComponent(String(input.before))}`,
      ),
    onSuccess: (result, variables) => {
      queryClient.setQueryData<{ turns: Turn[] }>(
        ["messages", variables.channelId, variables.sessionId],
        (current) => ({
          turns: dedupeTurns([...(result.turns ?? []), ...(current?.turns ?? [])]),
        }),
      );
      setHasOlderHistory(result.turns.length >= 50);
      setVisibleEntryCount((current) => current + result.turns.length);
    },
  });
  const tokenUsageQuery = useQuery({
    queryKey: ["tokens", selectedSessionId],
    enabled: Boolean(selectedSessionId),
    queryFn: async () =>
      requestJson<{ turns: Turn[] }>(CHAT_API_PATHS.SESSION_TOKENS(selectedSessionId!)),
  });
  const sessionParticipantsQuery = useQuery({
    queryKey: ["session-participants", selectedSessionId],
    enabled: Boolean(selectedSessionId),
    queryFn: async () =>
      requestJson<{ participants: SessionParticipant[] }>(`${CHAT_API_PATHS.SESSION(selectedSessionId!)}/participants`),
  });
  const companyDirectoryQuery = useQuery({
    queryKey: ["company-directory", companyId],
    enabled: Boolean(companyId && newDmOpen),
    queryFn: async () =>
      requestJson<{ participants: SessionParticipant[] }>(CHAT_API_PATHS.COMPANY_DIRECTORY(companyId!)),
  });

  useEffect(() => {
    if (!selectedChannel || usingFallbackChannels || sessionIdsByChannel[selectedChannel.id] || openSessionMutation.isPending) {
      return;
    }

    openSessionMutation.mutate(selectedChannel);
  }, [openSessionMutation, selectedChannel, sessionIdsByChannel, usingFallbackChannels]);

  useEffect(() => {
    setMobileSidebarOpen(false);
    setCrystallizedIssueId(null);
    setStreamingEntry(null);
    setTypingAgents([]);
  }, [location.pathname, location.search]);

  useEffect(() => {
    if (!newDmOpen) {
      setNewDmParticipantId(null);
    }
  }, [newDmOpen]);

  useEffect(() => {
    setHasOlderHistory(false);
  }, [selectedSessionId]);

  const liveEntries = (messagesQuery.data?.turns ?? []).map(mapTurnToEntry);
  const sessionState = sessionStateQuery.data?.session ?? null;
  const agentStates = sessionStateQuery.data?.agentStates ?? [];
  const sessionSummary = sessionStateQuery.data?.summary ?? null;
  const tokenTurns = tokenUsageQuery.data?.turns ?? [];
  const totalTokenCount = tokenTurns.reduce((sum, turn) => sum + turn.tokenCount, 0);
  const sessionClosed = sessionState?.status === "closed";
  const previewEntries: ThreadEntry[] = buildThreadPreview(
    selectedChannel,
    optimisticMessages[selectedChannel?.id ?? ""] ?? [],
    liveEntries,
  );
  const latestDecisionEntry = [...previewEntries].reverse().find((entry) => entry.isDecision) ?? liveDecision;
  const mentionCandidates = buildMentionCandidates(sessionParticipantsQuery.data?.participants ?? [], presenceByAgent);
  const mentionSuggestions = readMentionSuggestions(draft, mentionCandidates);
  const dmDirectoryEntries = companyDirectoryQuery.data?.participants ?? [];
  const selectedDmParticipant =
    dmDirectoryEntries.find((participant) => participant.participantId === newDmParticipantId) ?? null;
  const previewsByChannel = Object.fromEntries(
    channels.map((channel) => {
      const preview = channel.id === selectedChannel?.id
        ? previewEntries.at(-1)
        : undefined;
      return [
        channel.id,
        {
          body: preview?.body ?? "",
          timestamp: preview?.timestamp ?? "",
        },
      ];
    }),
  );

  useEffect(() => {
    setVisibleEntryCount(20);
    setStreamingEntry(null);
    setTypingAgents([]);
  }, [selectedChannelId, selectedSessionId]);

  useEffect(() => {
    if ((messagesQuery.data?.turns?.length ?? 0) >= 50) {
      setHasOlderHistory(true);
    }
  }, [messagesQuery.data?.turns?.length]);

  useChatWebSocket({
    channelId: selectedChannel?.id ?? null,
    sessionId: selectedSessionId,
    getLastSeq: () =>
      selectedChannel?.id
        ? queryClient.getQueryData<{ turns: Turn[] }>(["messages", selectedChannel.id, selectedSessionId])?.turns.at(-1)?.seq ?? 0
        : 0,
    onMessage: (data) => {
      const envelope = parseWsEnvelope(data);
      if (!envelope) {
        return;
      }

      if (envelope.type === "chat.message") {
        const turn = readTurnPayload(envelope.payload);
        if (!turn || !selectedChannel || !selectedSessionId) {
          return;
        }

        queryClient.setQueryData<{ turns: Turn[] }>(
          ["messages", selectedChannel.id, selectedSessionId],
          (current) => ({
            turns: dedupeTurns([...(current?.turns ?? []), turn]),
          }),
        );
        setOptimisticMessages((current) => ({
          ...current,
          [selectedChannel.id]: (current[selectedChannel.id] ?? []).filter((entry) => entry.body !== turn.content),
        }));
        return;
      }

      if (envelope.type === "session.decision") {
        const turn = readTurnPayload(envelope.payload);
        if (!turn || !selectedChannel || !selectedSessionId) {
          return;
        }

        setLiveDecision(mapTurnToEntry(turn));
        return;
      }

      if (envelope.type === "session.summary") {
        const summary = readSessionSummaryPayload(envelope.payload);
        if (!summary || !selectedSessionId || summary.sessionId !== selectedSessionId) {
          return;
        }

        queryClient.setQueryData<{ session: ChatSession; agentStates: AgentChannelState[]; summary: SessionSummary | null }>(
          ["session", selectedSessionId],
          (current) => current
            ? {
                ...current,
                summary,
              }
            : undefined,
        );
        return;
      }

      if (envelope.type === "chat.message.stream") {
        const stream = readStreamPayload(envelope.payload);
        if (!stream || !selectedChannel || !selectedSessionId) {
          return;
        }

        if (stream.done) {
          setStreamingEntry(null);
          setTypingAgents((current) => current.filter((agent) => agent !== stream.participantId));
          return;
        }

        setTypingAgents((current) => current.includes(stream.participantId) ? current : [...current, stream.participantId]);
        setStreamingEntry((current) => ({
          id: current?.id ?? `stream-${stream.participantId}`,
          author: `Agent ${stream.participantId.slice(0, 6)}`,
          kind: "agent",
          timestamp: "live",
          body: `${current?.body ?? ""}${stream.delta}`,
          isDecision: false,
        }));
        return;
      }

      if (envelope.type === "agent.typing") {
        const typing = readTypingPayload(envelope.payload);
        if (!typing || !selectedChannel) {
          return;
        }

        setTypingAgents((current) =>
          typing.active
            ? current.includes(typing.participantId)
              ? current
              : [...current, typing.participantId]
            : current.filter((agent) => agent !== typing.participantId),
        );
        return;
      }

      if (envelope.type === "notification.new") {
        const notification = readNotificationPayload(envelope.payload);
        if (!notification) {
          return;
        }

        queryClient.setQueryData<{ notifications: Notification[] }>(["notifications"], (current) => ({
          notifications: dedupeNotifications([notification, ...(current?.notifications ?? [])]),
        }));
        return;
      }

      if (envelope.type === "agent.status") {
        const presence = readPresencePayload(envelope.payload);
        if (!presence) {
          return;
        }

        setPresenceByAgent((current) => ({
          ...current,
          [presence.agentId]: {
            status: presence.status,
            updatedAt: presence.updatedAt,
          },
        }));
        return;
      }

      if (envelope.type === "session.closed") {
        const closedSessionId = readSessionClosedPayload(envelope.payload);
        if (!closedSessionId || !selectedSessionId || closedSessionId !== selectedSessionId) {
          return;
        }

        queryClient.setQueryData<{ session: ChatSession; agentStates: AgentChannelState[]; summary: SessionSummary | null }>(
          ["session", selectedSessionId],
          (current) => current
            ? {
                ...current,
                session: {
                  ...current.session,
                  status: "closed",
                },
              }
            : undefined,
        );
      }
    },
  });

  if (!selectedChannel && channels.length > 0 && location.pathname !== "/notifications") {
    return <Navigate to={`/channels/${channels[0]!.id}${location.search}`} replace />;
  }

  return (
    <main className="flex min-h-screen flex-col bg-white text-neutral-950">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-stone-200 px-4">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-bold text-stone-900">{APP_NAME}</h1>
            <div className="flex items-center gap-2 lg:hidden">
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(true)}
                className="px-2 py-1 text-[13px] font-medium text-stone-600 transition-colors hover:text-stone-900"
              >
                <PanelLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setMobileActivityOpen(true)}
                className="px-2 py-1 text-[13px] font-medium text-stone-600 transition-colors hover:text-stone-900"
              >
                <PanelRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <StatusPill label="Server" value={healthQuery.data?.status ?? "…"} tone={healthQuery.data?.status === "ok" ? "green" : "amber"} />
            <StatusPill label="Paperclip" value={healthQuery.data?.paperclip ?? "…"} tone={healthQuery.data?.paperclip === "connected" ? "green" : "amber"} />
            <StatusPill label="Realtime" value={healthQuery.data?.ws ?? "…"} tone={healthQuery.data?.ws === "running" ? "green" : "amber"} />
            <span className="ml-1 text-[10px] font-mono text-stone-400">
              {companyId ? companyId.slice(0, 8) : "no company"}
            </span>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[240px_minmax(0,1fr)_280px]">
          <div className="hidden border-r border-stone-200 lg:block">
            <Sidebar
              channels={channels}
              selectedChannelId={selectedChannelId}
              unreadCountByChannel={unreadCountByChannel}
              sessionIdsByChannel={sessionIdsByChannel}
              notifications={notifications}
              previewsByChannel={previewsByChannel}
              usingFallbackChannels={usingFallbackChannels}
              canCreateDm={Boolean(companyId) && !usingFallbackChannels}
              onSelectChannel={(channelId) =>
                startTransition(() => {
                  navigate(`/channels/${channelId}${location.search}`);
                })
              }
              onCreateDm={() => setNewDmOpen(true)}
            />
          </div>

          <section className="flex min-h-0 flex-col">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-stone-200 px-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-stone-900">
                  {selectedChannel?.name ?? "No channel selected"}
                </h2>
                {selectedSessionId ? (
                  <span className="text-[10px] font-mono text-stone-400">
                    seq {sessionState?.currentSeq ?? 0}
                  </span>
                ) : null}
                {sessionClosed ? (
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] font-medium uppercase text-stone-500">
                    closed
                  </span>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {agentStates.map((state) => (
                  <span
                    key={state.id}
                    className="inline-flex items-center gap-1.5 text-xs text-stone-500"
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", agentStateToneClass(state.status))} />
                    {state.participantId.slice(0, 6)}
                  </span>
                ))}
                {Object.entries(presenceByAgent).map(([agentId, presence]) => (
                  <span
                    key={agentId}
                    className="inline-flex items-center gap-1.5 text-xs text-stone-500"
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", presenceToneClass(presence.status))} />
                    {agentId.slice(0, 6)}
                  </span>
                ))}
                {selectedSessionId && !usingFallbackChannels ? (
                  <button
                    type="button"
                    onClick={() => closeSessionMutation.mutate({ sessionId: selectedSessionId })}
                    disabled={sessionClosed || closeSessionMutation.isPending}
                    className="px-2 py-1 text-xs font-medium text-stone-500 transition-colors hover:text-stone-900 disabled:text-stone-300"
                  >
                    {closeSessionMutation.isPending ? "Closing…" : sessionClosed ? "" : "Close"}
                  </button>
                ) : null}
              </div>
            </div>

            <ChatThread
              selectedChannelName={selectedChannel?.name ?? null}
              sessionState={sessionState}
              agentStates={agentStates}
              presenceByAgent={presenceByAgent}
              sessionId={selectedSessionId}
              sessionClosed={sessionClosed}
              openingSession={!usingFallbackChannels && !selectedSessionId}
              liveDecision={liveDecision}
              summaryText={sessionSummary?.text ?? null}
              summaryTokenCount={sessionSummary?.tokenCount ?? null}
              crystallizing={closeSessionMutation.isPending}
              crystallizedIssueId={crystallizedIssueId}
              streamingEntry={streamingEntry}
              typingAgents={typingAgents}
              entries={previewEntries}
              visibleCount={visibleEntryCount}
              hasOlderHistory={hasOlderHistory}
              loadingOlder={loadOlderMessagesMutation.isPending}
              onShowMore={() => {
                if (visibleEntryCount < previewEntries.length) {
                  setVisibleEntryCount((current) => current + 20);
                  return;
                }

                const earliestSeq = messagesQuery.data?.turns?.[0]?.seq;
                if (!selectedChannel || !selectedSessionId || earliestSeq === undefined || loadOlderMessagesMutation.isPending || !hasOlderHistory) {
                  return;
                }

                loadOlderMessagesMutation.mutate({
                  channelId: selectedChannel.id,
                  sessionId: selectedSessionId,
                  before: earliestSeq,
                });
              }}
              onDismissDecision={() => setLiveDecision(null)}
              onCrystallize={() => {
                if (!selectedSessionId) {
                  return;
                }
                setCrystallizeConfirmOpen(true);
              }}
            />

            <div className="border-t border-stone-200 px-4 py-3">
              <MessageInput
                draft={draft}
                onDraftChange={setDraft}
                onSubmit={() => {
                  if (!selectedChannel || !draft.trim() || !selectedSessionId) {
                    return;
                  }

                  const channelId = selectedChannel.id;
                  const nextDraft = draft.trim();
                  const mentionedIds = readMentionedIds(nextDraft, mentionCandidates);
                  const nextEntry: ThreadEntry = {
                    id: `${channelId}-optimistic-${Date.now()}`,
                    author: "Operator",
                    kind: "human",
                    timestamp: "now",
                    body: nextDraft,
                    isDecision: false,
                    tokenCount: null,
                  };

                  setOptimisticMessages((current) => ({
                    ...current,
                    [channelId]: [...(current[channelId] ?? []), nextEntry],
                  }));
                  setDraft("");

                  sendMessageMutation.mutate(
                    {
                      sessionId: selectedSessionId,
                      channelId,
                      text: nextDraft,
                      mentionedIds,
                    },
                    {
                      onError: () => {
                        setOptimisticMessages((current) => ({
                          ...current,
                          [channelId]: (current[channelId] ?? []).filter((entry) => entry.id !== nextEntry.id),
                        }));
                        setDraft(nextDraft);
                      },
                    },
                  );
                }}
                disabled={!selectedChannel || !selectedSessionId || sessionClosed}
                pending={sendMessageMutation.isPending}
                sessionClosed={sessionClosed}
                hasSession={Boolean(selectedSessionId)}
                suggestions={mentionSuggestions}
                onSelectMention={(candidate) => setDraft(insertMention(draft, candidate.label))}
              />
            </div>
          </section>

          <div className="hidden border-l border-stone-200 lg:block">
            <NotificationPanel
              notifications={notifications}
              selectedSessionId={selectedSessionId}
              totalTokenCount={totalTokenCount}
              tokenTurns={tokenTurns}
              unauthenticated={unauthenticatedNotifications}
              notificationsRoute={notificationsRoute}
              pending={markNotificationsReadMutation.isPending}
              onOpenChannel={(channelId) => navigate(`/channels/${channelId}${location.search}`)}
              onMarkRead={(notificationIds) => markNotificationsReadMutation.mutate(notificationIds)}
            />
          </div>
        </div>
      {mobileSidebarOpen ? (
        <div className="fixed inset-0 z-40 bg-black/30 px-4 py-4 lg:hidden">
          <div className="flex h-full max-w-sm flex-col">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(false)}
                className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700"
              >
                <X className="h-4 w-4" />
                Close
              </button>
            </div>
            <Sidebar
              channels={channels}
              selectedChannelId={selectedChannelId}
              unreadCountByChannel={unreadCountByChannel}
              sessionIdsByChannel={sessionIdsByChannel}
              notifications={notifications}
              previewsByChannel={previewsByChannel}
              usingFallbackChannels={usingFallbackChannels}
              canCreateDm={Boolean(companyId) && !usingFallbackChannels}
              onSelectChannel={(channelId) =>
                startTransition(() => {
                  navigate(`/channels/${channelId}${location.search}`);
                })
              }
              onCreateDm={() => {
                setMobileSidebarOpen(false);
                setNewDmOpen(true);
              }}
            />
          </div>
        </div>
      ) : null}
      {mobileActivityOpen ? (
        <div className="fixed inset-0 z-40 bg-black/30 px-4 py-4 lg:hidden">
          <div className="ml-auto flex h-full max-w-sm flex-col">
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setMobileActivityOpen(false)}
                className="inline-flex items-center gap-2 rounded-md border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700"
              >
                <X className="h-4 w-4" />
                Close
              </button>
            </div>
            <NotificationPanel
              compact
              notifications={notifications}
              selectedSessionId={selectedSessionId}
              totalTokenCount={totalTokenCount}
              tokenTurns={tokenTurns}
              unauthenticated={unauthenticatedNotifications}
              pending={markNotificationsReadMutation.isPending}
              onOpenChannel={(channelId) => {
                setMobileActivityOpen(false);
                navigate(`/channels/${channelId}${location.search}`);
              }}
              onMarkRead={(notificationIds) => markNotificationsReadMutation.mutate(notificationIds)}
            />
          </div>
        </div>
      ) : null}
      {newDmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
          <div className="w-full max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Direct Message</p>
                <h2 className="mt-1 text-xl font-semibold text-stone-900">Create DM channel</h2>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  Create a dedicated direct-message channel in the current company. The session opens immediately after creation.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setNewDmOpen(false);
                  setNewDmParticipantId(null);
                }}
                className="rounded-md border border-stone-200 bg-stone-50 p-2 text-stone-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form
              className="mt-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!companyId || !selectedDmParticipant) {
                  return;
                }
                createDmMutation.mutate({
                  companyId,
                  participant: selectedDmParticipant,
                });
              }}
            >
              <div>
                <p className="text-sm font-medium text-stone-700">Choose a participant</p>
                <div className="mt-3 max-h-72 space-y-2 overflow-y-auto">
                  {dmDirectoryEntries.map((participant) => (
                    <button
                      key={participant.participantId}
                      type="button"
                      onClick={() => setNewDmParticipantId(participant.participantId)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md border px-4 py-3 text-left transition",
                        participant.participantId === newDmParticipantId
                          ? "border-stone-900 bg-stone-100"
                          : "border-stone-200 bg-stone-50 hover:bg-stone-100",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-stone-900">
                          {participant.displayName ?? participant.mentionLabel ?? participant.participantId}
                        </span>
                        <span className="block truncate text-xs text-stone-500">
                          @{participant.mentionLabel ?? participant.participantId}
                        </span>
                      </span>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
                        {participant.participantType}
                      </span>
                    </button>
                  ))}
                </div>
                {companyDirectoryQuery.isLoading ? (
                  <p className="mt-3 text-sm text-stone-500">Loading company participants…</p>
                ) : null}
                {companyDirectoryQuery.isError ? (
                  <p className="mt-3 text-sm text-red-600">Could not load company participants.</p>
                ) : null}
              </div>
              <div className="mt-5 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setNewDmOpen(false);
                    setNewDmParticipantId(null);
                  }}
                  className="rounded-md border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!companyId || !selectedDmParticipant || createDmMutation.isPending}
                  className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-stone-300"
                >
                  {createDmMutation.isPending ? "Creating…" : "Create DM"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
      <CrystallizeCard
        open={crystallizeConfirmOpen}
        summaryText={sessionSummary?.text ?? null}
        decisionText={latestDecisionEntry?.body ?? null}
        crystallizing={closeSessionMutation.isPending}
        disabled={!selectedSessionId || sessionClosed}
        onCancel={() => setCrystallizeConfirmOpen(false)}
        onConfirm={() => {
          if (!selectedSessionId) {
            return;
          }
          closeSessionMutation.mutate(
            { sessionId: selectedSessionId, crystallize: true },
            {
              onSuccess: () => {
                setCrystallizeConfirmOpen(false);
              },
            },
          );
        }}
      />
    </main>
  );
}

function buildThreadPreview(channel: Channel | null, optimisticEntries: ThreadEntry[], liveEntries: ThreadEntry[]): ThreadEntry[] {
  if (!channel) {
    return [];
  }

  if (liveEntries.length > 0) {
    return [...liveEntries, ...optimisticEntries];
  }

  return [
    {
      id: `${channel.id}-1`,
      author: "Operator",
      kind: "human" as const,
      timestamp: "just now",
      body: `Opened ${channel.name} and prepared the chat surface for live session traffic.`,
      isDecision: false,
      tokenCount: null,
    },
    {
      id: `${channel.id}-2`,
      author: "paperclip-chat",
      kind: "agent" as const,
      timestamp: "live",
      body: "Session routes, token counting, history pagination, and notifications are now wired. Composer send and realtime thread hydration are next.",
      isDecision: false,
      tokenCount: null,
    },
    ...optimisticEntries,
  ];
}

function dedupeTurns(turns: Turn[]) {
  const seen = new Set<string>();
  return turns.filter((turn) => {
    if (seen.has(turn.id)) {
      return false;
    }
    seen.add(turn.id);
    return true;
  });
}

function dedupeNotifications(notifications: Notification[]) {
  const seen = new Set<string>();
  return notifications.filter((notification) => {
    if (seen.has(notification.id)) {
      return false;
    }
    seen.add(notification.id);
    return true;
  });
}

function mapTurnToEntry(turn: Turn): ThreadEntry {
  return {
    id: turn.id,
    author: `Participant ${turn.fromParticipantId.slice(0, 6)}`,
    kind: turn.fromParticipantId.startsWith("agent") ? "agent" : "human",
    timestamp: new Date(turn.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    body: turn.content,
    isDecision: turn.isDecision,
    tokenCount: turn.tokenCount,
  };
}

function readCompanyId() {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get("companyId");
}

function parseWsEnvelope(value: unknown): { type: string; payload: unknown } | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as { type?: unknown; payload?: unknown };
    return typeof parsed.type === "string" ? { type: parsed.type, payload: parsed.payload } : null;
  } catch {
    return null;
  }
}

function readTurnPayload(value: unknown): Turn | null {
  if (!isRecord(value) || !isRecord(value.turn)) {
    return null;
  }

  const turn = value.turn as Record<string, unknown>;
  return typeof turn.id === "string" &&
    typeof turn.sessionId === "string" &&
    typeof turn.seq === "number" &&
    typeof turn.fromParticipantId === "string" &&
    typeof turn.content === "string" &&
    typeof turn.tokenCount === "number" &&
    typeof turn.summarize === "boolean" &&
    typeof turn.isDecision === "boolean" &&
    typeof turn.createdAt === "string"
    ? {
        id: turn.id,
        sessionId: turn.sessionId,
        seq: turn.seq,
        fromParticipantId: turn.fromParticipantId,
        content: turn.content,
        tokenCount: turn.tokenCount,
        summarize: turn.summarize,
        mentionedIds: Array.isArray(turn.mentionedIds) ? turn.mentionedIds.filter((item): item is string => typeof item === "string") : null,
        isDecision: turn.isDecision,
        createdAt: turn.createdAt,
      }
    : null;
}

function readNotificationPayload(value: unknown): Notification | null {
  if (!isRecord(value)) {
    return null;
  }

  return typeof value.id === "string" &&
    typeof value.userId === "string" &&
    typeof value.companyId === "string" &&
    typeof value.type === "string" &&
    isRecord(value.payload) &&
    (typeof value.readAt === "string" || value.readAt === null) &&
    typeof value.createdAt === "string"
    ? {
        id: value.id,
        userId: value.userId,
        companyId: value.companyId,
        type: value.type as Notification["type"],
        payload: value.payload,
        readAt: value.readAt,
        createdAt: value.createdAt,
      }
    : null;
}

function readSessionClosedPayload(value: unknown): string | null {
  if (!isRecord(value) || typeof value.sessionId !== "string") {
    return null;
  }

  return value.sessionId;
}

function readSessionSummaryPayload(value: unknown): SessionSummary | null {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.text !== "string" || typeof value.tokenCount !== "number") {
    return null;
  }

  return {
    sessionId: value.sessionId,
    text: value.text,
    tokenCount: value.tokenCount,
    chunkSeqCovered: typeof value.chunkSeqCovered === "number" ? value.chunkSeqCovered : 0,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function readStreamPayload(value: unknown): { participantId: string; delta: string; done: boolean } | null {
  if (!isRecord(value) || typeof value.participantId !== "string" || typeof value.delta !== "string" || typeof value.done !== "boolean") {
    return null;
  }

  return {
    participantId: value.participantId,
    delta: value.delta,
    done: value.done,
  };
}

function readTypingPayload(value: unknown): { participantId: string; active: boolean } | null {
  if (!isRecord(value) || typeof value.participantId !== "string" || typeof value.active !== "boolean") {
    return null;
  }

  return {
    participantId: value.participantId,
    active: value.active,
  };
}

function readPresencePayload(value: unknown): { agentId: string; status: string; updatedAt: string } | null {
  if (!isRecord(value) || typeof value.agentId !== "string" || typeof value.status !== "string") {
    return null;
  }

  return {
    agentId: value.agentId,
    status: value.status,
    updatedAt: typeof value.timestamp === "string" ? value.timestamp : new Date().toISOString(),
  };
}

function presenceToneClass(status: string) {
  switch (status) {
    case "running":
    case "busy":
      return "bg-amber-500 animate-pulse";
    case "idle":
      return "bg-green-500";
    default:
      return "bg-gray-400";
  }
}

function agentStateToneClass(status: AgentChannelState["status"]) {
  switch (status) {
    case "active":
      return "bg-green-500";
    case "observing":
      return "bg-amber-500";
    default:
      return "bg-gray-400";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildMentionCandidates(
  participants: SessionParticipant[],
  presenceByAgent: Record<string, AgentPresence>,
): MentionCandidate[] {
  const seen = new Set<string>();
  const candidates: MentionCandidate[] = [];

  for (const participant of participants) {
    if (seen.has(participant.participantId)) {
      continue;
    }
    seen.add(participant.participantId);
    candidates.push({
      id: participant.participantId,
      label:
        participant.mentionLabel ??
        slugifyMentionCandidate(participant.displayName ?? `${participant.participantType}-${participant.participantId.slice(0, 6)}`),
      displayName: participant.displayName ?? undefined,
      kind: participant.participantType,
    });
  }

  for (const agentId of Object.keys(presenceByAgent)) {
    if (seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    candidates.push({
      id: agentId,
      label: `agent-${agentId.slice(0, 6)}`,
      displayName: undefined,
      kind: "agent",
    });
  }

  return candidates;
}

function readMentionSuggestions(draft: string, candidates: MentionCandidate[]) {
  const match = /(^|\s)@([a-z0-9-]*)$/i.exec(draft);
  if (!match) {
    return [];
  }

  const query = match[2]?.toLowerCase() ?? "";
  return candidates.filter((candidate) => candidate.label.toLowerCase().includes(query)).slice(0, 5);
}

function insertMention(draft: string, label: string) {
  return draft.replace(/(^|\s)@([a-z0-9-]*)$/i, (_whole, prefix) => `${prefix}@${label} `);
}

function readMentionedIds(draft: string, candidates: MentionCandidate[]) {
  const lowered = draft.toLowerCase();
  return candidates
    .filter((candidate) => lowered.includes(`@${candidate.label.toLowerCase()}`))
    .map((candidate) => candidate.id);
}

function slugifyMentionCandidate(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "participant";
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function requestVoid(path: string, init?: RequestInit): Promise<void> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
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
