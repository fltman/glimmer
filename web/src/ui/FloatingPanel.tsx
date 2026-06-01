/**
 * FloatingPanel — a draggable glass card that hosts a summoned panel over the
 * canvas in omni mode. The panel content (Layers, AI, Adjustments, …) is passed
 * as children; this shell owns the chrome: a drag handle, a title, and a close.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export function FloatingPanel({
  title,
  onClose,
  children,
  width = 340,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  // Default position: upper-right, clear of the corner chrome.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(12, window.innerWidth - width - 20),
    y: 64,
  }));
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // Esc closes the card (unless focus is in a field inside it).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      )
        return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const x = Math.min(
      Math.max(8, e.clientX - drag.current.dx),
      window.innerWidth - 60,
    );
    const y = Math.min(
      Math.max(8, e.clientY - drag.current.dy),
      window.innerHeight - 60,
    );
    setPos({ x, y });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  return (
    <div
      className="animate-pop pointer-events-auto absolute z-40 flex max-h-[82vh] flex-col overflow-hidden rounded-xl border border-edge bg-panel/95 shadow-2xl backdrop-blur"
      style={{ left: pos.x, top: pos.y, width }}
    >
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex shrink-0 cursor-grab items-center justify-between border-b border-edge px-3 py-2 active:cursor-grabbing"
      >
        <span className="select-none text-[11px] font-semibold uppercase tracking-wider text-muted">
          {title}
        </span>
        <button
          onClick={onClose}
          className="flex items-center rounded p-0.5 text-muted hover:bg-edge hover:text-ink"
          title="Close (Esc)"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}
