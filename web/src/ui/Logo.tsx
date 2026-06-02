/**
 * Brand lockup — the Glimmer mark + wordmark. One component so the mark stays
 * identical everywhere it appears (toolbar, doc pill, dialogs). The mark is the
 * app's generated emblem (web/public/glimmer-icon.png); the wordmark stays as
 * crisp text so it reads at toolbar size.
 */
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
      <img
        src="/glimmer-icon.png"
        alt="Glimmer"
        draggable={false}
        className={`object-cover shadow-sm ring-1 ring-white/10 ${
          sm ? "h-5 w-5 rounded" : "h-6 w-6 rounded-md"
        }`}
      />
      {showWordmark && (
        <span
          className={`font-semibold tracking-tight text-ink ${sm ? "text-[13px]" : "text-sm"}`}
        >
          Glimmer
        </span>
      )}
    </span>
  );
}
