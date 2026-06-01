/**
 * Brand lockup — a gradient "spark" mark + the ai·ps wordmark. One component so
 * the mark stays identical everywhere it appears (toolbar, doc pill, dialogs).
 */
import { Sparkles } from "lucide-react";

export function Logo({
  size = "md",
  showWordmark = true,
}: {
  size?: "sm" | "md";
  showWordmark?: boolean;
}) {
  const sm = size === "sm";
  return (
    <span className="flex select-none items-center gap-2">
      <span
        className={`flex items-center justify-center bg-gradient-to-br from-accent to-fuchsia-500 text-white shadow-sm ring-1 ring-white/10 ${
          sm ? "h-4 w-4 rounded" : "h-5 w-5 rounded-md"
        }`}
      >
        <Sparkles size={sm ? 10 : 12} strokeWidth={2.25} />
      </span>
      {showWordmark && (
        <span
          className={`font-semibold tracking-tight text-ink ${sm ? "text-[13px]" : "text-sm"}`}
        >
          ai<span className="text-accent">·</span>ps
        </span>
      )}
    </span>
  );
}
