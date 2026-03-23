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
  crystallizeFeedback: string | null;
  streamingEntry: ThreadEntry | null;
  typingAgents: string[];
  participantNames: Record<string, string>;
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
  const showEmptyState = !props.openingSession && !props.sessionClosed && activityEntries.length === 0 && !props.streamingEntry;

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto px-4 py-3"
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
        <p className="py-3 text-xs text-stone-400">Opening session…</p>
      ) : null}
      {props.sessionClosed ? (
        <p className="py-3 text-xs text-stone-400">Session closed — read-only transcript.</p>
      ) : null}
      {props.liveDecision ? (
        <article className="border-l-2 border-amber-400 py-3 pl-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-medium uppercase tracking-widest font-mono text-amber-600">Decision</p>
            <button
              type="button"
              onClick={props.onDismissDecision}
              className="text-xs text-stone-400 transition-colors hover:text-stone-900"
            >
              dismiss
            </button>
          </div>
          <p className="mt-1 text-sm leading-6 text-stone-700">{props.liveDecision.body}</p>
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
      {props.crystallizeFeedback ? (
        <article className="border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900">
          <p className="text-[10px] font-medium uppercase tracking-widest font-mono text-emerald-700">Crystallized</p>
          <p className="mt-1 leading-6">{props.crystallizeFeedback}</p>
        </article>
      ) : null}
      {showLoadOlder ? (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={props.onShowMore}
            disabled={props.loadingOlder}
            className="text-xs font-medium text-stone-400 transition-colors hover:text-stone-900"
          >
            {loadOlderLabel}
          </button>
        </div>
      ) : null}
      {showEmptyState ? (
        <div className="border border-dashed border-stone-200 bg-stone-50 px-4 py-5 text-sm text-stone-600">
          <p className="font-medium text-stone-800">No messages yet.</p>
          <p className="mt-1 leading-6">Start the conversation here. Agents marked as “not in context” have not been pulled into this chat yet.</p>
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
          {props.typingAgents.map((agentId) => props.participantNames[agentId] ?? agentId.slice(0, 6)).join(", ")} {props.typingAgents.length === 1 ? "is" : "are"} typing…
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
            className="rounded-full bg-stone-900 px-3 py-1.5 text-[10px] font-medium text-white"
          >
            {newMessageCount} new message{newMessageCount === 1 ? "" : "s"}
          </button>
        </div>
      ) : null}
      {props.agentStates.length > 0 || Object.keys(props.presenceByAgent).length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-stone-100 py-3">
          {props.agentStates.map((state) => (
            <span key={state.id} className="inline-flex items-center gap-1.5 text-xs text-stone-500" title={`Chat context: ${formatAgentContextLabel(state.status)}`}>
              <span className={cn("h-1.5 w-1.5 rounded-full", agentStateToneClass(state.status))} />
              {props.participantNames[state.participantId] ?? state.participantId.slice(0, 6)} {formatAgentContextLabel(state.status)}
            </span>
          ))}
          {Object.entries(props.presenceByAgent).map(([agentId, presence]) => (
            <span key={agentId} className="inline-flex items-center gap-1.5 text-xs text-stone-500" title={`Runtime: ${formatPresenceLabel(presence.status)}`}>
              <span className={cn("h-1.5 w-1.5 rounded-full", presenceToneClass(presence.status))} />
              {props.participantNames[agentId] ?? agentId.slice(0, 6)} {formatPresenceLabel(presence.status)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ThreadRow(props: { entry: ThreadEntry; streaming?: boolean }) {
  const { entry } = props;

  return (
    <article
      className={cn(
        "border-b border-stone-100 py-3 last:border-b-0",
        entry.isDecision ? "border-l-2 border-l-amber-400 pl-3" : "",
        entry.kind === "human" ? "bg-neutral-100/60 -mx-4 px-4" : "",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              entry.kind === "agent" ? "bg-green-500" : "bg-stone-300",
            )}
          />
          <span className="text-[13px] font-medium text-stone-900">{entry.author}</span>
          {entry.isDecision ? (
            <span className="text-[10px] font-medium uppercase text-amber-600">decision</span>
          ) : null}
          {entry.tokenCount !== null && entry.tokenCount !== undefined ? (
            <span className="text-[10px] font-mono text-stone-400">{entry.tokenCount}</span>
          ) : null}
        </div>
        <span className="text-[11px] text-stone-400">{entry.timestamp}</span>
      </div>
      <div className="mt-1.5 max-w-none text-sm leading-6 text-stone-700">
        <Suspense fallback={<div className="whitespace-pre-wrap text-sm leading-6 text-stone-700">{`${entry.body}${props.streaming ? "▍" : ""}`}</div>}>
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

function formatPresenceLabel(status: string) {
  switch (status) {
    case "idle":
      return "ready";
    case "running":
      return "running";
    case "busy":
    case "busy_task":
    case "busy_dm":
      return "busy";
    case "error":
      return "error";
    default:
      return status;
  }
}

function formatAgentContextLabel(status: AgentChannelState["status"]) {
  switch (status) {
    case "active":
      return "active in context";
    case "observing":
      return "watching context";
    default:
      return "not in context";
  }
}
