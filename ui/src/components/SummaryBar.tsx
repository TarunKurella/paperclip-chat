export function SummaryBar(props: {
  summaryText: string;
  summaryTokenCount: number | null;
  crystallizing: boolean;
  crystallizedIssueId: string | null;
  disabled: boolean;
  onCrystallize(): void;
}) {
  return (
    <section className="rounded-sm border border-stone-200 bg-white px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">Summary</p>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 text-stone-700">{props.summaryText}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.summaryTokenCount !== null ? (
            <span className="rounded-sm border border-stone-200 bg-stone-50 px-2 py-1 text-[11px] font-medium text-stone-600">
              {props.summaryTokenCount} tok
            </span>
          ) : null}
          <button
            type="button"
            onClick={props.onCrystallize}
            disabled={props.crystallizing || props.disabled}
            className="rounded-sm border border-stone-200 bg-stone-50 px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:bg-stone-100 disabled:cursor-not-allowed disabled:text-stone-400"
          >
            {props.crystallizing ? "Crystallizing…" : "Crystallize"}
          </button>
        </div>
      </div>
      {props.crystallizedIssueId ? (
        <p className="mt-3 text-xs text-stone-500">Created Paperclip issue {props.crystallizedIssueId}.</p>
      ) : null}
    </section>
  );
}
