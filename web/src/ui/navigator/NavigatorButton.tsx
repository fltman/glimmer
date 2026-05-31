/**
 * Toolbar button that opens the Navigator panel as a dropdown popover.
 *
 * Self-contained (owns open/close + outside-click + Escape) so the Toolbar only
 * needs to render <NavigatorButton/>. The panel mounts lazily so its throttled
 * GPU-readback loop only runs while open.
 */
import { useEffect, useRef, useState } from "react";
import { NavigatorPanel } from "./NavigatorPanel";

export function NavigatorButton({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        className="btn"
        disabled={disabled}
        title={disabled ? "Open an image first" : "Navigator (overview + pan)"}
        onClick={() => setOpen((o) => !o)}
      >
        {/* compass / map glyph */}
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          className="opacity-90"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path d="M10.5 5.5 7 7 5.5 10.5 9 9z" strokeLinejoin="round" />
        </svg>
        Navigator
      </button>

      {open && !disabled && (
        <div className="absolute right-0 top-full z-40 mt-1 rounded-md border border-edge bg-panelraised p-3 shadow-2xl">
          <NavigatorPanel />
        </div>
      )}
    </div>
  );
}
