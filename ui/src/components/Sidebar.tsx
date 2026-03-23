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
  canCreateChannel: boolean;
  canCreateDm: boolean;
  onOpenRuntimeSettings(): void;
  onSelectChannel(channelId: string): void;
  onCreateChannel(): void;
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
      channels: props.channels.filter(
        (channel) => channel.type === "company_general" || channel.type === "project" || channel.type === "task_thread",
      ),
    },
    {
      label: "Direct Messages",
      channels: props.channels.filter((channel) => channel.type === "dm"),
    },
  ];

  return (
    <aside className="flex h-full flex-col overflow-y-auto bg-white">
      <div className="flex h-12 shrink-0 items-center justify-between px-3">
        <span className="text-sm font-bold text-stone-900">Messages</span>
        <span className="text-[10px] font-mono text-stone-400">{props.channels.length}</span>
      </div>
      {props.usingFallbackChannels ? (
        <p className="px-3 pb-2 text-xs text-stone-400">Preview mode</p>
      ) : null}

      <div className="flex-1 space-y-3 px-2 py-2">
        {pendingChannels.length > 0 ? (
          <section className="px-1">
            <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-widest font-mono text-amber-600/80">
              Pending requests
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
            <div className="flex items-center justify-between px-2 py-1.5">
              <p className="text-[10px] font-medium uppercase tracking-widest font-mono text-stone-400">{group.label}</p>
              {group.label === "Channels" ? (
                <button
                  type="button"
                  disabled={!props.canCreateChannel}
                  onClick={props.onCreateChannel}
                  className={cn(
                    "text-[11px] font-medium transition-colors",
                    props.canCreateChannel ? "text-stone-500 hover:text-stone-900" : "text-stone-300",
                  )}
                >
                  + Channel
                </button>
              ) : null}
              {group.label === "Direct Messages" ? (
                <button
                  type="button"
                  disabled={!props.canCreateDm}
                  onClick={props.onCreateDm}
                  className={cn(
                    "text-[11px] font-medium transition-colors",
                    props.canCreateDm ? "text-stone-500 hover:text-stone-900" : "text-stone-300",
                  )}
                >
                  + DM
                </button>
              ) : null}
            </div>
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
              {group.channels.length === 0 ? (
                <p className="px-2 py-2 text-[12px] text-stone-400">
                  {group.label === "Direct Messages" ? "No direct messages yet." : "No channels yet."}
                </p>
              ) : null}
            </div>
          </section>
        ))}
      </div>
      <div className="border-t border-stone-200 px-3 py-3">
        <button
          type="button"
          onClick={props.onOpenRuntimeSettings}
          className="w-full rounded-md border border-stone-200 px-3 py-2 text-left text-[12px] font-medium text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-900"
        >
          Runtime settings
        </button>
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
        "flex w-full items-start gap-2.5 px-2 py-2 text-left transition-colors",
        props.selected ? "bg-stone-100 text-stone-900" : props.emphasized ? "text-stone-800 hover:bg-amber-50/60" : "text-stone-700 hover:bg-stone-50",
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
              <span className="rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-600">
                live
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            {props.preview?.timestamp ? (
              <span className="text-[11px] font-medium text-stone-400">{props.preview.timestamp}</span>
            ) : null}
            {props.unreadCount > 0 ? (
              <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
                {props.unreadCount}
              </span>
            ) : null}
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stone-300" />
          </div>
        </div>
        <p className="mt-0.5 text-[10px] font-mono uppercase tracking-widest text-stone-400">{props.channel.type.replace("_", " ")}</p>
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
    return "Custom channel ready for a focused group conversation.";
  }
  return "Live channel transcript hydrates when the session is opened.";
}
