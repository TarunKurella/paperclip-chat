import type { AgentChannelState, ChatSession } from "@paperclip-chat/shared";
import { cn } from "../lib/utils.js";

export interface ThreadEntry {
  id: string;
  author: string;
  kind: "human" | "agent";
  timestamp: string;
  body: string;
  isDecision: boolean;
}

export interface AgentPresence {
  status: string;
  updatedAt: string;
}

export function ChatThread(props: {
  selectedChannelName: string | null;
  sessionState: ChatSession | null;
  agentStates: AgentChannelState[];
  presenceByAgent: Record<string, AgentPresence>;
  sessionId: string | null;
  sessionClosed: boolean;
  openingSession: boolean;
  liveDecision: ThreadEntry | null;
  entries: ThreadEntry[];
  visibleCount: number;
  onShowMore(): void;
  onDismissDecision(): void;
}) {
  const hiddenCount = Math.max(props.entries.length - props.visibleCount, 0);
  const visibleEntries = hiddenCount > 0 ? props.entries.slice(-props.visibleCount) : props.entries;

  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
      {!props.sessionClosed && props.openingSession ? (
        <article className="rounded-3xl border border-dashed border-stone-300 bg-stone-50 px-4 py-4 text-sm text-stone-500">
          Opening a session for this channel…
        </article>
      ) : null}
      {props.sessionClosed ? (
        <article className="rounded-3xl border border-stone-200 bg-stone-100 px-4 py-4 text-sm text-stone-600">
          This session has been closed. You can still review the transcript, but sending is disabled.
        </article>
      ) : null}
      {props.liveDecision ? (
        <article className="rounded-3xl border border-amber-200 bg-amber-50 px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <p className="text-sm font-semibold text-stone-900">Live decision</p>
            </div>
            <button
              type="button"
              onClick={props.onDismissDecision}
              className="rounded-full border border-amber-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700"
            >
              dismiss
            </button>
          </div>
          <p className="mt-3 text-sm leading-7 text-stone-700">{props.liveDecision.body}</p>
        </article>
      ) : null}
      {hiddenCount > 0 ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={props.onShowMore}
            className="rounded-full border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-600 transition hover:bg-stone-50"
          >
            Show {hiddenCount} earlier message{hiddenCount === 1 ? "" : "s"}
          </button>
        </div>
      ) : null}
      {visibleEntries.map((entry) => (
        <article
          key={entry.id}
          className={cn(
            "rounded-3xl border px-4 py-4",
            entry.isDecision ? "border-amber-200 bg-amber-50/80" : "border-stone-200 bg-stone-50/70",
          )}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  entry.kind === "agent" ? "bg-green-500" : "bg-gray-400",
                )}
              />
              <p className="text-sm font-semibold text-stone-900">{entry.author}</p>
              <span className="text-xs uppercase tracking-[0.16em] text-stone-500">{entry.kind}</span>
              {entry.isDecision ? (
                <span className="rounded-full border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
                  decision
                </span>
              ) : null}
            </div>
            <span className="text-xs text-stone-500">{entry.timestamp}</span>
          </div>
          <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-stone-700">{entry.body}</p>
        </article>
      ))}
      {props.agentStates.length > 0 || Object.keys(props.presenceByAgent).length > 0 ? (
        <section className="rounded-3xl border border-stone-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">Realtime activity</p>
          {props.agentStates.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {props.agentStates.map((state) => (
                <span
                  key={state.id}
                  className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700"
                >
                  <span className={cn("h-2 w-2 rounded-full", agentStateToneClass(state.status))} />
                  {state.participantId.slice(0, 6)} {state.status} · idle {state.idleTurnCount}
                </span>
              ))}
            </div>
          ) : null}
          {Object.keys(props.presenceByAgent).length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {Object.entries(props.presenceByAgent).map(([agentId, presence]) => (
                <span
                  key={agentId}
                  className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700"
                >
                  <span className={cn("h-2 w-2 rounded-full", presenceToneClass(presence.status))} />
                  {agentId.slice(0, 6)} {presence.status}
                </span>
              ))}
            </div>
          ) : null}
          {props.sessionState?.status === "active" && props.sessionId ? (
            <p className="mt-3 text-sm leading-6 text-stone-500">
              Active session {props.sessionId.slice(0, 8)}… is ready for live updates in {props.selectedChannelName ?? "this thread"}.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
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
