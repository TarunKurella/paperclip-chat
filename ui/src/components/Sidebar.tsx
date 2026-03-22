import type { Notification, Channel } from "@paperclip-chat/shared";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils.js";

interface SidebarPreview {
  body: string;
  timestamp: string;
}

export function Sidebar(props: {
  channels: Channel[];
  selectedChannelId: string | null;
  unreadCountByChannel: Record<string, number>;
  sessionIdsByChannel: Record<string, string>;
  notifications: Notification[];
  previewsByChannel: Record<string, SidebarPreview>;
  usingFallbackChannels: boolean;
  canCreateDm: boolean;
  onSelectChannel(channelId: string): void;
  onCreateDm(): void;
}) {
  const pendingChannelIds = new Set(
    props.notifications
      .filter((notification) => notification.type === "agent_initiated")
      .map((notification) =>
        typeof notification.payload.channelId === "string" ? notification.payload.channelId : null,
      )
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
  const pendingChannels = props.channels.filter((channel) => pendingChannelIds.has(channel.id));
  const grouped = [
    {
      label: "Channels",
      channels: props.channels.filter((channel) => channel.type === "company_general" || channel.type === "project"),
    },
    {
      label: "Direct Messages",
      channels: props.channels.filter((channel) => channel.type === "dm"),
    },
    {
      label: "Threads",
      channels: props.channels.filter((channel) => channel.type === "task_thread"),
    },
  ].filter((group) => group.channels.length > 0);

  return (
    <aside className="rounded-lg border border-stone-200 bg-white shadow-sm">
      <div className="border-b border-stone-200 px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Channels</p>
            <h2 className="mt-1 text-lg font-semibold">Conversation Surface</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!props.canCreateDm}
              onClick={props.onCreateDm}
              className={cn(
                "rounded-md border px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] transition",
                props.canCreateDm
                  ? "border-stone-200 bg-stone-50 text-stone-700 hover:bg-stone-100"
                  : "border-stone-200 bg-stone-50 text-stone-400",
              )}
            >
              New DM
            </button>
            <span className="rounded-sm bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-600">
              {props.channels.length}
            </span>
          </div>
        </div>
        {props.usingFallbackChannels ? (
          <p className="mt-3 text-sm leading-6 text-stone-500">
            Showing local preview channels until a live company context is available.
          </p>
        ) : null}
      </div>

      <div className="space-y-4 px-3 py-3">
        {pendingChannels.length > 0 ? (
          <section className="rounded-md border border-amber-200 bg-amber-50 px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">
              Pending agent requests
            </p>
            <div className="mt-2 space-y-1">
              {pendingChannels.map((channel) => (
                <SidebarRow
                  key={`pending-${channel.id}`}
                  channel={channel}
                  preview={props.previewsByChannel[channel.id]}
                  unreadCount={props.unreadCountByChannel[channel.id] ?? 0}
                  hasSession={Boolean(props.sessionIdsByChannel[channel.id])}
                  selected={channel.id === props.selectedChannelId}
                  emphasized
                  onClick={() => props.onSelectChannel(channel.id)}
                />
              ))}
            </div>
          </section>
        ) : null}

        {grouped.map((group) => (
          <section key={group.label}>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">{group.label}</p>
            <div className="mt-2 space-y-1">
              {group.channels.map((channel) => (
                <SidebarRow
                  key={channel.id}
                  channel={channel}
                  preview={props.previewsByChannel[channel.id]}
                  unreadCount={props.unreadCountByChannel[channel.id] ?? 0}
                  hasSession={Boolean(props.sessionIdsByChannel[channel.id])}
                  selected={channel.id === props.selectedChannelId}
                  onClick={() => props.onSelectChannel(channel.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

function SidebarRow(props: {
  channel: Channel;
  preview?: SidebarPreview;
  unreadCount: number;
  hasSession: boolean;
  selected: boolean;
  emphasized?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-md border border-transparent px-3 py-2 text-left transition",
        props.selected ? "border-stone-200 bg-stone-100" : props.emphasized ? "hover:bg-amber-100/80" : "hover:bg-stone-50",
      )}
    >
      <div className={cn("mt-1 h-2.5 w-2.5 rounded-full", props.unreadCount > 0 ? "bg-blue-500" : props.hasSession ? "bg-green-500" : "bg-gray-400")} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <p className={cn("truncate text-[13px] text-stone-900", props.unreadCount > 0 ? "font-semibold" : "font-medium")}>
              {props.channel.name}
            </p>
            {props.hasSession ? (
              <span className="rounded-sm border border-stone-200 bg-white px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-stone-500">
                live
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {props.preview?.timestamp ? (
              <span className="text-[11px] font-medium text-stone-400">{props.preview.timestamp}</span>
            ) : null}
            {props.unreadCount > 0 ? (
              <span className="rounded-sm bg-blue-500 px-2 py-0.5 text-[11px] font-semibold text-white">
                {props.unreadCount}
              </span>
            ) : null}
            <ChevronRight className="h-4 w-4 shrink-0 text-stone-400" />
          </div>
        </div>
        <p className="mt-1 text-xs uppercase tracking-[0.16em] text-stone-500">{props.channel.type.replace("_", " ")}</p>
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-5 text-stone-500">
          {props.preview?.body ?? defaultPreview(props.channel)}
        </p>
      </div>
    </button>
  );
}

function defaultPreview(channel: Channel): string {
  if (channel.type === "dm") {
    return "Direct conversation ready for live follow-up.";
  }
  if (channel.type === "task_thread") {
    return "Threaded task discussion will appear here.";
  }
  return "Live channel transcript hydrates when the session is opened.";
}
