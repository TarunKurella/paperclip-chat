export function SummaryBar(props: {
  summaryText: string;
  summaryTokenCount: number | null;
  crystallizing: boolean;
  crystallizedIssueId: string | null;
  disabled: boolean;
  onCrystallize(): void;
}) {
  return (
    <section className="border-b border-stone-100 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-widest font-mono text-stone-400">Summary</p>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-stone-600">{props.summaryText}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {props.summaryTokenCount !== null ? (
            <span className="text-[10px] font-mono text-stone-400">{props.summaryTokenCount}</span>
          ) : null}
          <button
            type="button"
            onClick={props.onCrystallize}
            disabled={props.crystallizing || props.disabled}
            className="text-xs font-medium text-stone-500 transition-colors hover:text-stone-900 disabled:text-stone-300"
          >
            {props.crystallizing ? "Crystallizing…" : "Crystallize"}
          </button>
        </div>
      </div>
      {props.crystallizedIssueId ? (
        <p className="mt-1 text-[10px] text-stone-400">Latest crystallized issue {props.crystallizedIssueId}</p>
      ) : null}
    </section>
  );
}
