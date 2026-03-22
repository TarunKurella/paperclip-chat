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
    <aside className={cn("h-full overflow-y-auto bg-white", props.compact ? "flex-1" : "")}>
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <BellRing className="h-3.5 w-3.5 text-stone-400" />
        <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-stone-400">Notifications</span>
        {props.selectedSessionId ? (
          <span className="ml-auto text-[10px] font-mono text-stone-400">{props.totalTokenCount} tok</span>
        ) : null}
      </div>
      {props.unauthenticated ? (
        <p className="px-3 pb-2 text-[11px] text-stone-400">Preview mode — no auth session</p>
      ) : null}
      <div className="divide-y divide-stone-100 px-3">
        {props.selectedSessionId && !props.compact ? (
          <section className="py-3">
            <p className="text-[10px] font-medium uppercase tracking-widest font-mono text-stone-400">Token usage</p>
            <div className="mt-2 space-y-1">
              {props.tokenTurns.slice(-5).reverse().map((turn) => (
                <div key={turn.id} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-stone-600">{turn.fromParticipantId.slice(0, 8)} · seq {turn.seq}</p>
                  </div>
                  <span className="shrink-0 text-[10px] font-mono text-stone-400">{turn.tokenCount}</span>
                </div>
              ))}
              {props.tokenTurns.length === 0 ? <p className="text-xs text-stone-400">No turns yet.</p> : null}
            </div>
          </section>
        ) : null}
        {!props.unauthenticated && props.notifications.length > 0 && !props.compact ? (
          <div className="flex justify-end py-2">
            <button
              type="button"
              onClick={() => props.onMarkRead(props.notifications.map((notification) => notification.id))}
              disabled={props.pending}
              className="text-xs font-medium text-stone-500 transition-colors hover:text-stone-900 disabled:text-stone-300"
            >
              {props.pending ? "Clearing…" : "Mark all read"}
            </button>
          </div>
        ) : null}
        {(props.compact ? props.notifications.slice(0, 6) : props.notifications).map((notification) => (
          <article key={`${props.compact ? "compact-" : ""}${notification.id}`} className="py-3">
            <div className="flex items-start justify-between gap-2">
              <p className="text-[13px] font-medium text-stone-900">{renderNotificationTitle(notification)}</p>
              {!props.compact ? <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-blue-500" /> : null}
            </div>
            <p className="mt-1 text-xs text-stone-500">{renderNotificationBody(notification)}</p>
            {typeof notification.payload.channelId === "string" ? (
              <div className="mt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => props.onOpenChannel(notification.payload.channelId as string)}
                  className="text-xs font-medium text-stone-600 transition-colors hover:text-stone-900"
                >
                  Open
                </button>
                {!props.unauthenticated && !props.compact ? (
                  <button
                    type="button"
                    onClick={() => props.onMarkRead([notification.id])}
                    disabled={props.pending}
                    className="text-xs font-medium text-stone-400 transition-colors hover:text-stone-900 disabled:text-stone-300"
                  >
                    Read
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
