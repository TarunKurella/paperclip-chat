import { Radio } from "lucide-react";
import { cn } from "../lib/utils.js";

export interface MentionCandidate {
  id: string;
  label: string;
  kind: "human" | "agent";
}

export function MessageInput(props: {
  draft: string;
  onDraftChange(value: string): void;
  onSubmit(): void;
  disabled: boolean;
  pending: boolean;
  sessionClosed: boolean;
  hasSession: boolean;
  suggestions: MentionCandidate[];
  onSelectMention(candidate: MentionCandidate): void;
}) {
  const draftLength = props.draft.length;

  return (
    <form
      className="rounded-md border border-stone-200 bg-stone-50 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-stone-700">
        <Radio className="h-4 w-4 text-blue-500" />
        Message composer
      </div>
      <label className="mt-3 block">
        <span className="sr-only">Draft message</span>
        <textarea
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          placeholder="Write a message. Use @mentions to wake a participant."
          disabled={props.disabled}
          className="min-h-28 w-full resize-none rounded-md border border-stone-200 bg-white px-4 py-3 text-sm leading-6 text-stone-800 outline-none transition placeholder:text-stone-400 focus:border-stone-400 disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500"
        />
      </label>
      {props.suggestions.length > 0 ? (
        <div className="mt-3 rounded-md border border-stone-200 bg-white p-2">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">
            Mention suggestions
          </p>
          <div className="space-y-1">
            {props.suggestions.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                onClick={() => props.onSelectMention(candidate)}
                className="flex w-full items-center justify-between rounded-sm px-3 py-2 text-left transition hover:bg-stone-50"
              >
                <span className="text-sm font-medium text-stone-900">@{candidate.label}</span>
                <span
                  className={cn(
                    "rounded-sm px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.14em]",
                    candidate.kind === "agent"
                      ? "bg-green-50 text-green-700"
                      : "bg-stone-100 text-stone-600",
                  )}
                >
                  {candidate.kind}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm leading-6 text-stone-500">
          {props.sessionClosed
            ? "This session is closed. Start or switch to another channel to continue chatting."
            : props.hasSession
            ? props.pending
              ? "Sending message to the live session…"
              : "Live session selected. Messages post to the session API and stay optimistic until the turn returns."
            : "Composer stays disabled until a live session is available for this channel."}
        </p>
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-stone-500">{draftLength}/10000</span>
          <button
            type="submit"
            disabled={props.disabled || props.pending || props.draft.trim().length === 0}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {props.pending ? "Sending…" : "Send message"}
          </button>
        </div>
      </div>
    </form>
  );
}
