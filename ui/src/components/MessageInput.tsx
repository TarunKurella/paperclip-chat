import { useLayoutEffect, useRef } from "react";
import { cn } from "../lib/utils.js";

export interface MentionCandidate {
  id: string;
  label: string;
  displayName?: string;
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
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
  }, [props.draft]);

  return (
    <form
      className="bg-white"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <label className="block">
        <span className="sr-only">Draft message</span>
        <textarea
          ref={textareaRef}
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) {
              return;
            }

            event.preventDefault();
            if (!props.disabled && !props.pending && props.draft.trim().length > 0) {
              props.onSubmit();
            }
          }}
          placeholder="Write a message…"
          disabled={props.disabled}
          maxLength={10000}
          className="min-h-16 w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-1 text-sm leading-6 text-stone-800 outline-none transition placeholder:text-stone-400 disabled:cursor-not-allowed disabled:text-stone-400"
        />
      </label>
      {props.suggestions.length > 0 ? (
        <div className="mt-1 border-t border-stone-100 pt-1">
          {props.suggestions.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => props.onSelectMention(candidate)}
              className="flex w-full items-center justify-between px-1 py-1.5 text-left transition-colors hover:bg-stone-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-stone-700">@{candidate.label}</span>
                {candidate.displayName && candidate.displayName.toLowerCase() !== candidate.label.toLowerCase() ? (
                  <span className="block truncate text-[11px] text-stone-400">{candidate.displayName}</span>
                ) : null}
              </span>
              <span
                className={cn(
                  "text-[10px] font-medium",
                  candidate.kind === "agent" ? "text-green-600" : "text-stone-400",
                )}
              >
                {candidate.kind}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-1 flex items-center justify-between">
        <span className="text-[10px] font-mono text-stone-300">{draftLength > 0 ? draftLength : ""}</span>
        <button
          type="submit"
          disabled={props.disabled || props.pending || props.draft.trim().length === 0}
          className="px-3 py-1.5 text-xs font-medium text-stone-900 transition-colors hover:bg-stone-50 disabled:text-stone-300"
        >
          {props.pending ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}
