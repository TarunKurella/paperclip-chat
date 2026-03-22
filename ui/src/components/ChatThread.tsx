import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChannelState, ChatSession } from "@paperclip-chat/shared";
import { cn } from "../lib/utils.js";
import { SummaryBar } from "./SummaryBar.js";

const MarkdownRenderer = lazy(() => import("./MarkdownRenderer.js").then((module) => ({ default: module.MarkdownRenderer })));

export interface ThreadEntry {
  id: string;
  author: string;
  kind: "human" | "agent";
  timestamp: string;
  body: string;
  isDecision: boolean;
  tokenCount?: number | null;
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
  summaryText: string | null;
  summaryTokenCount: number | null;
  crystallizing: boolean;
  crystallizedIssueId: string | null;
  streamingEntry: ThreadEntry | null;
  typingAgents: string[];
  entries: ThreadEntry[];
  visibleCount: number;
  hasOlderHistory: boolean;
  loadingOlder: boolean;
  onShowMore(): void;
  onDismissDecision(): void;
  onCrystallize(): void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const hiddenCount = Math.max(props.entries.length - props.visibleCount, 0);
  const visibleEntries = hiddenCount > 0 ? props.entries.slice(-props.visibleCount) : props.entries;
  const renderedCount = visibleEntries.length + (props.streamingEntry ? 1 : 0);
  const previousRenderedCount = useRef(renderedCount);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    if (isAtBottom) {
      container.scrollTop = container.scrollHeight;
      setNewMessageCount(0);
      previousRenderedCount.current = renderedCount;
      return;
    }

    if (renderedCount > previousRenderedCount.current) {
      setNewMessageCount((current) => current + (renderedCount - previousRenderedCount.current));
    }
    previousRenderedCount.current = renderedCount;
  }, [isAtBottom, renderedCount]);

  const showLoadOlder = hiddenCount > 0 || props.hasOlderHistory;
  const loadOlderLabel = hiddenCount > 0
    ? `Show ${hiddenCount} earlier message${hiddenCount === 1 ? "" : "s"}`
    : props.loadingOlder
      ? "Loading earlier messages…"
      : "Load older messages";

  const activityEntries = useMemo(() => visibleEntries, [visibleEntries]);

  return (
    <div
      ref={scrollRef}
      className="flex-1 space-y-4 overflow-y-auto px-6 py-5"
      onScroll={(event) => {
        const target = event.currentTarget;
        const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
        setIsAtBottom(nearBottom);
        if (nearBottom) {
          setNewMessageCount(0);
        }
      }}
    >
      {!props.sessionClosed && props.openingSession ? (
        <article className="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-3 text-sm text-stone-500">
          Opening a session for this channel…
        </article>
      ) : null}
      {props.sessionClosed ? (
        <article className="rounded-sm border border-stone-200 bg-stone-100 px-4 py-3 text-sm text-stone-600">
          This session has been closed. You can still review the transcript, but sending is disabled.
        </article>
      ) : null}
      {props.liveDecision ? (
        <article className="rounded-sm border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
              <p className="text-sm font-semibold text-stone-900">Live decision</p>
            </div>
            <button
              type="button"
              onClick={props.onDismissDecision}
              className="rounded-sm border border-amber-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700"
            >
              dismiss
            </button>
          </div>
          <p className="mt-3 text-sm leading-7 text-stone-700">{props.liveDecision.body}</p>
        </article>
      ) : null}
      {props.summaryText ? (
        <SummaryBar
          summaryText={props.summaryText}
          summaryTokenCount={props.summaryTokenCount}
          crystallizing={props.crystallizing}
          crystallizedIssueId={props.crystallizedIssueId}
          disabled={props.sessionClosed}
          onCrystallize={props.onCrystallize}
        />
      ) : null}
      {showLoadOlder ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={props.onShowMore}
            disabled={props.loadingOlder}
            className="rounded-sm border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-600 transition hover:bg-stone-50"
          >
            {loadOlderLabel}
          </button>
        </div>
      ) : null}
      {activityEntries.map((entry) => (
        <ThreadRow key={entry.id} entry={entry} />
      ))}
      {props.streamingEntry ? (
        <ThreadRow entry={props.streamingEntry} streaming />
      ) : null}
      {props.typingAgents.length > 0 ? (
        <div className="border-b border-stone-200 px-1 py-4 text-sm text-stone-500">
          {props.typingAgents.join(", ")} {props.typingAgents.length === 1 ? "is" : "are"} typing…
        </div>
      ) : null}
      {!isAtBottom && newMessageCount > 0 ? (
        <div className="sticky bottom-0 flex justify-center pb-2">
          <button
            type="button"
            onClick={() => {
              const container = scrollRef.current;
              if (container) {
                container.scrollTop = container.scrollHeight;
              }
              setNewMessageCount(0);
              setIsAtBottom(true);
            }}
            className="rounded-sm border border-stone-200 bg-white px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] text-stone-700 shadow-sm"
          >
            {newMessageCount} new message{newMessageCount === 1 ? "" : "s"}
          </button>
        </div>
      ) : null}
      {props.agentStates.length > 0 || Object.keys(props.presenceByAgent).length > 0 ? (
        <section className="rounded-sm border border-stone-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">Realtime activity</p>
          {props.agentStates.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {props.agentStates.map((state) => (
                <span
                  key={state.id}
                  className="inline-flex items-center gap-2 rounded-sm border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700"
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
                  className="inline-flex items-center gap-2 rounded-sm border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700"
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

function ThreadRow(props: { entry: ThreadEntry; streaming?: boolean }) {
  const { entry } = props;

  return (
    <article
      className={cn(
        "border-b border-stone-200 px-1 py-4 last:border-b-0",
        entry.isDecision ? "bg-amber-50/70" : "bg-transparent",
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
          <p className="text-[13px] font-semibold text-stone-900">{entry.author}</p>
          <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500">{entry.kind}</span>
          {entry.isDecision ? (
            <span className="rounded-sm border border-amber-200 bg-white px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-700">
              decision
            </span>
          ) : null}
          {props.streaming ? (
            <span className="rounded-sm border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
              streaming
            </span>
          ) : null}
          {entry.tokenCount !== null && entry.tokenCount !== undefined ? (
            <span className="rounded-sm border border-stone-200 bg-stone-50 px-2 py-0.5 text-[11px] font-medium text-stone-600">
              {entry.tokenCount} tok
            </span>
          ) : null}
        </div>
        <span className="text-xs text-stone-500">{entry.timestamp}</span>
      </div>
      <div className="prose prose-stone mt-3 max-w-none text-[15px] leading-7">
        <Suspense fallback={<div className="whitespace-pre-wrap text-[15px] leading-7 text-stone-700">{`${entry.body}${props.streaming ? "▍" : ""}`}</div>}>
          <MarkdownRenderer body={entry.body} streaming={props.streaming} />
        </Suspense>
      </div>
    </article>
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
