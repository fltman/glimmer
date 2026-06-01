/**
 * EmptyState — a small, centered "nothing here yet" placeholder for panels
 * (Layers, Paths, History…): an iconed badge + a title + an optional hint, so an
 * empty panel reads as intentional and inviting rather than blank.
 */
import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-edge bg-panelraised text-muted">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <p className="text-xs font-semibold text-ink">{title}</p>
      {hint && (
        <p className="max-w-[15rem] text-[11px] leading-relaxed text-muted">{hint}</p>
      )}
    </div>
  );
}
