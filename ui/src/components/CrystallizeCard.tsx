export function CrystallizeCard(props: {
  open: boolean;
  summaryText: string | null;
  decisionText: string | null;
  crystallizing: boolean;
  disabled: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  if (!props.open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <div className="w-full max-w-2xl rounded-sm border border-stone-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-500">Crystallize</p>
            <h2 className="mt-1 text-xl font-semibold text-stone-900">Confirm Paperclip issue handoff</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              This will create a Paperclip issue snapshot from the current chat context. The conversation stays open.
            </p>
          </div>
        </div>

        <section className="mt-5 rounded-sm border border-stone-200 bg-stone-50 px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-500">Summary preview</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-700">
            {props.summaryText ?? "No folded summary is available yet. The server will fall back to the recent transcript when crystallizing."}
          </p>
        </section>

        <section className="mt-4 rounded-sm border border-amber-200 bg-amber-50 px-4 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-700">Decision preview</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-stone-700">
            {props.decisionText ?? "No explicit decision turn is currently visible. Crystallize will still use the best available summary and recent context."}
          </p>
        </section>

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.crystallizing}
            className="rounded-sm border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 disabled:cursor-not-allowed disabled:text-stone-400"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={props.onConfirm}
            disabled={props.crystallizing || props.disabled}
            className="rounded-sm bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {props.crystallizing ? "Crystallizing…" : "Confirm crystallize"}
          </button>
        </div>
      </div>
    </div>
  );
}
