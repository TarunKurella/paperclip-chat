import { cn } from "../lib/utils.js";

export function StatusPill(props: { label: string; value: string; tone: "green" | "amber" }) {
  const toneClass = props.tone === "green" ? "bg-green-500" : "bg-amber-500";

  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <span className={cn("h-1.5 w-1.5 rounded-full", toneClass)} />
      <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-stone-400">{props.label}</span>
      <span className="text-xs font-medium text-stone-600">{props.value}</span>
    </div>
  );
}
