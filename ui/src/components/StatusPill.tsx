import { cn } from "../lib/utils.js";

export function StatusPill(props: { label: string; value: string; tone: "green" | "amber" }) {
  const toneClass = props.tone === "green" ? "bg-green-500" : "bg-amber-500";

  return (
    <div className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5">
      <span className={cn("h-2 w-2 rounded-full", toneClass)} />
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">{props.label}</span>
      <span className="text-sm font-medium text-stone-700">{props.value}</span>
    </div>
  );
}
