import type { Notification, Turn } from "@paperclip-chat/shared";
import { BellRing, TriangleAlert } from "lucide-react";
import { cn } from "../lib/utils.js";

export function NotificationPanel(props: {
  notifications: Notification[];
  selectedSessionId: string | null;
  totalTokenCount: number;
  tokenTurns: Turn[];
  unauthenticated: boolean;
  notificationsRoute?: boolean;
  compact?: boolean;
  pending: boolean;
  onOpenChannel(channelId: string): void;
  onMarkRead(notificationIds?: string[]): void;
}) {
  return (
    <aside className={cn("border border-stone-200 bg-white shadow-sm", props.compact ? "flex-1 overflow-y-auto rounded-sm" : "hidden rounded-sm lg:block")}>
      <div className="border-b border-stone-200 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="rounded-sm bg-amber-50 p-2 text-amber-600">
            <BellRing className="h-4 w-4" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Notifications</p>
            <h2 className="text-lg font-semibold">Unread Queue</h2>
          </div>
        </div>
        {props.selectedSessionId ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium text-stone-600">
            <span className="rounded-sm border border-stone-200 bg-stone-50 px-3 py-1.5">total {props.totalTokenCount} tok</span>
            <span className="rounded-sm border border-stone-200 bg-stone-50 px-3 py-1.5">turns {props.tokenTurns.length}</span>
          </div>
        ) : null}
        {props.unauthenticated ? (
          <div className="mt-3 flex items-start gap-2 rounded-sm border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Showing preview notifications until a Paperclip-authenticated browser session is present.</p>
          </div>
        ) : null}
      </div>
      <div className="space-y-3 px-4 py-4">
        {props.selectedSessionId && !props.compact ? (
          <section className="rounded-sm border border-stone-200 bg-stone-50 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-stone-900">Session telemetry</p>
                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">token usage</p>
              </div>
              <span className="text-xs text-stone-500">{props.totalTokenCount} tok</span>
            </div>
            <div className="mt-3 space-y-2">
              {props.tokenTurns.slice(-5).reverse().map((turn) => (
                <div key={turn.id} className="flex items-center justify-between gap-3 rounded-sm border border-stone-200 bg-white px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-stone-900">{turn.fromParticipantId.slice(0, 8)} · seq {turn.seq}</p>
                    <p className="truncate text-xs text-stone-500">{new Date(turn.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-stone-700">{turn.tokenCount} tok</span>
                </div>
              ))}
              {props.tokenTurns.length === 0 ? <p className="text-sm text-stone-500">No tokenized turns yet.</p> : null}
            </div>
          </section>
        ) : null}
        {!props.unauthenticated && props.notifications.length > 0 && !props.compact ? (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => props.onMarkRead(props.notifications.map((notification) => notification.id))}
              disabled={props.pending}
              className="rounded-sm border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
            >
              {props.pending ? "Clearing…" : "Mark all read"}
            </button>
          </div>
        ) : null}
        {(props.compact ? props.notifications.slice(0, 6) : props.notifications).map((notification) => (
          <article key={`${props.compact ? "compact-" : ""}${notification.id}`} className="rounded-sm border border-stone-200 bg-stone-50 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-stone-900">{renderNotificationTitle(notification)}</p>
                {!props.compact ? (
                  <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">{notification.type.replace("_", " ")}</p>
                ) : null}
              </div>
              {!props.compact ? <div className="h-2.5 w-2.5 rounded-full bg-blue-500" /> : null}
            </div>
            <p className="mt-3 text-sm leading-6 text-stone-600">{renderNotificationBody(notification)}</p>
            {typeof notification.payload.channelId === "string" ? (
              <div className="mt-3 flex justify-between gap-3">
                <button
                  type="button"
                  onClick={() => props.onOpenChannel(notification.payload.channelId as string)}
                  className={cn(
                    "rounded-sm border px-3 py-1.5 text-xs font-medium transition",
                    props.notificationsRoute ? "border-amber-200 bg-amber-50 text-amber-700" : "border-stone-200 bg-white text-stone-700 hover:bg-stone-100",
                  )}
                >
                  Open channel
                </button>
                {!props.unauthenticated && !props.compact ? (
                  <button
                    type="button"
                    onClick={() => props.onMarkRead([notification.id])}
                    disabled={props.pending}
                    className="rounded-sm border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
                  >
                    Mark read
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
      </div>
    </aside>
  );
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
