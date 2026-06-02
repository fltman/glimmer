/**
 * SelectionRefineDialog — the omni-workspace prompt for Feather / Grow / Shrink
 * selection. The classic Select menu uses an anchored PxPopover; in omni there
 * is no menu to anchor to, so this is a small centred modal opened via
 * `workspaceStore.openSelectionRefine(op)`. It owns only the draft px value and
 * commits via the engine action. React never touches pixels.
 */
import { useEffect, useRef, useState } from "react";
import { actions } from "../../state/useEngine";
import type { SelectionRefineOp } from "../../state/workspace";

const META: Record<
  SelectionRefineOp,
  {
    title: string;
    label: string;
    initial: number;
    min: number;
    max: number;
    apply: (px: number) => void;
  }
> = {
  feather: {
    title: "Feather selection",
    label: "Radius",
    initial: 2,
    min: 0,
    max: 250,
    apply: (px) => actions.featherSelection(px),
  },
  expand: {
    title: "Grow selection",
    label: "Amount",
    initial: 4,
    min: 1,
    max: 100,
    apply: (px) => actions.expandSelection(px),
  },
  contract: {
    title: "Shrink selection",
    label: "Amount",
    initial: 4,
    min: 1,
    max: 100,
    apply: (px) => actions.contractSelection(px),
  },
};

export function SelectionRefineDialog({
  op,
  onClose,
}: {
  op: SelectionRefineOp;
  onClose: () => void;
}) {
  const meta = META[op];
  const [value, setValue] = useState<number>(meta.initial);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus + select the input on mount for fast keyboard entry.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const clamped = Math.min(
    meta.max,
    Math.max(meta.min, Number.isFinite(value) ? value : meta.min),
  );
  function apply() {
    meta.apply(clamped);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[18vh]"
      onMouseDown={onClose}
    >
      <div
        className="animate-pop w-64 rounded-xl border border-edge bg-panelraised p-4 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-semibold text-ink">{meta.title}</div>
        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted">
          {meta.label}
        </label>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="number"
            min={meta.min}
            max={meta.max}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => setValue(Number(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              }
            }}
            className="w-full rounded border border-edge bg-[#0f1012] px-2 py-1 text-sm tabular-nums text-ink outline-none focus:border-accent"
          />
          <span className="text-xs text-muted">px</span>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-accent" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
