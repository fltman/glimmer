/**
 * WYSIWYG type-tool editing overlay.
 *
 * The engine owns the text layer and its rasterization; this component is a
 * visual-only editor. It watches `engine.getActiveTextEditing()` (polled via
 * rAF, since the engine is imperative and doesn't push per-frame updates) and,
 * while a text layer is being edited, renders an absolutely-positioned
 * <textarea> directly over the canvas at the layer's screen rect.
 *
 * The textarea is styled to match the layer's font family / size / color /
 * alignment / line-height (the font size is scaled by the current zoom so it
 * tracks the on-canvas glyphs 1:1). The committed text is drawn in GL by the
 * engine, so while editing we make the engine's own glyphs invisible (alpha 0)
 * by overlaying the textarea opaquely — i.e. the textarea IS what you see while
 * typing, and on commit the engine's raster takes over seamlessly.
 *
 * Keystrokes are kept local: the textarea stops propagation so they never reach
 * the global single-key tool shortcuts in App.tsx. Enter inserts a newline (a
 * text layer is multi-line); Escape commits + closes; blur commits + closes.
 *
 * Edit lifecycle:
 *   - On a new edit session we capture the layer's pre-edit param snapshot
 *     (`prevRef`) so commit can push exactly one undo step (prev -> next).
 *   - Each keystroke calls actions.updateTextLayer({ text }) for live preview.
 *   - Commit calls actions.commitTextLayer(id, prev, next) then endEditText().
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { engine, actions } from "../../state/useEngine";
import type { TextLayerSnapshot } from "../../model/Document";
import { rgbaCss } from "../color/colorMath";

/** Shape returned by engine.getActiveTextEditing() (kept local for clarity). */
type ActiveEdit = NonNullable<ReturnType<typeof engine.getActiveTextEditing>>;

export function TextEditOverlay() {
  // The current edit descriptor (null when no text layer is being edited).
  const [edit, setEdit] = useState<ActiveEdit | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Per-session refs: which layer we're editing, its pre-edit snapshot, and the
  // latest text typed (so blur/escape commit the freshest value, not stale
  // closure state).
  const layerIdRef = useRef<string | null>(null);
  const prevRef = useRef<TextLayerSnapshot | null>(null);
  const textRef = useRef<string>("");
  const committedRef = useRef(false);

  // Poll the imperative engine each frame. getActiveTextEditing() already
  // returns screen-space (CSS px) placement and the live typographic params, so
  // we just mirror it into React state when something meaningful changes. We
  // intentionally keep the textarea's *value* uncontrolled-ish: it's driven by
  // `edit.text` only across session changes, while live typing flows out via
  // actions.updateTextLayer and is reflected back by the next poll.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const next = engine.getActiveTextEditing();
      setEdit((prev) => (sameEdit(prev, next) ? prev : next));
      // Keep the caret in the textarea during an active session. Creating the
      // text layer via a canvas click can leave focus on <body>/<canvas>, which
      // would route keystrokes to the global tool shortcuts instead of the
      // editor. Re-assert focus ONLY when it has drifted to a non-editable
      // element, so we never steal focus from the tool-options inputs.
      if (next) {
        const ta = textareaRef.current;
        const ae = document.activeElement as HTMLElement | null;
        const aeEditable =
          !!ae &&
          (ae.tagName === "INPUT" ||
            ae.tagName === "TEXTAREA" ||
            ae.isContentEditable);
        if (ta && ae !== ta && !aeEditable) {
          ta.focus({ preventScroll: true });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Detect session start/change. When the edited layer id changes we (re)capture
  // the pre-edit snapshot from the layer's React snapshot `.text` field so the
  // undo step records the true prior state, and we autofocus + place the caret
  // at the end of the existing text.
  useLayoutEffect(() => {
    if (!edit) {
      layerIdRef.current = null;
      prevRef.current = null;
      return;
    }
    if (layerIdRef.current === edit.layerId) {
      // Same session: keep our cached "latest text" roughly in sync with the
      // engine in case it changed underneath us (e.g. param panel edits).
      textRef.current = edit.text;
      return;
    }
    // New session.
    layerIdRef.current = edit.layerId;
    committedRef.current = false;
    textRef.current = edit.text;
    prevRef.current = snapshotFromActive(edit);

    const ta = textareaRef.current;
    if (ta) {
      ta.value = edit.text;
      ta.focus({ preventScroll: true });
      const end = edit.text.length;
      try {
        ta.setSelectionRange(end, end);
      } catch {
        /* selectionRange unsupported on some states — ignore */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.layerId]);

  // Keep the uncontrolled textarea's value aligned with the engine when the text
  // changes from outside this component (e.g. an undo while editing) but NOT on
  // our own keystrokes (those already updated the DOM value natively).
  useEffect(() => {
    if (!edit) return;
    const ta = textareaRef.current;
    if (ta && ta.value !== edit.text && document.activeElement !== ta) {
      ta.value = edit.text;
      textRef.current = edit.text;
    }
  }, [edit?.text, edit?.layerId, edit]);

  if (!edit) return null;

  // Current zoom (doc -> CSS px). The screenRect is already in CSS px; the font
  // size must be scaled by the same factor so the textarea glyphs match the
  // engine's rasterized glyphs exactly.
  const scale = engine.getViewTransform().scale;
  const cssFontSize = Math.max(1, edit.fontSize * scale);
  const { x, y, width, height } = edit.screenRect;

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    const id = layerIdRef.current;
    const prev = prevRef.current;
    if (id && prev) {
      const next: TextLayerSnapshot = { ...prev, text: textRef.current };
      // Only record an undo step if something actually changed.
      if (!sameSnapshot(prev, next)) {
        actions.commitTextLayer(id, prev, next);
      }
    }
    actions.endEditText();
  };

  const cancelClose = () => {
    // Esc behaves like commit (Photoshop keeps the typed text on Esc-out of the
    // type tool); we already pushed live updates via updateTextLayer, so commit
    // folds them into a single undo step.
    commit();
  };

  return (
    <textarea
      ref={textareaRef}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      // Defer the initial value to the imperative focus effect to avoid React
      // re-controlling it on every poll; we use defaultValue for the very first
      // mount only.
      defaultValue={edit.text}
      onChange={(e) => {
        const text = e.currentTarget.value;
        textRef.current = text;
        const id = layerIdRef.current;
        if (id) actions.updateTextLayer(id, { text });
      }}
      onKeyDown={(e) => {
        // Never let type-tool keystrokes reach the global tool shortcuts.
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          cancelClose();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          // Cmd/Ctrl+Enter commits (plain Enter inserts a newline).
          e.preventDefault();
          commit();
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
      onKeyPress={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={commit}
      className="absolute z-20 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${Math.max(width, cssFontSize)}px`,
        height: `${Math.max(height, cssFontSize * edit.lineHeight)}px`,
        fontFamily: edit.fontFamily,
        fontSize: `${cssFontSize}px`,
        lineHeight: edit.lineHeight,
        fontWeight: edit.bold ? 700 : 400,
        fontStyle: edit.italic ? "italic" : "normal",
        textAlign: edit.align,
        color: rgbaCss(edit.color),
        // A faint caret-coloured ring so the user can see the editable region
        // over an arbitrary canvas without obscuring the glyphs.
        boxShadow: "0 0 0 1px rgba(91,140,255,0.7)",
        caretColor: rgbaCss({ ...edit.color, a: 1 }),
        whiteSpace: "pre",
        // The engine still rasterizes the same text underneath; matching the
        // exact metrics keeps the two visually coincident, so no flicker on
        // commit. Disable browser text rendering tweaks that would diverge.
        WebkitFontSmoothing: "antialiased",
      }}
    />
  );
}

/** True when two active-edit descriptors are equivalent for render purposes. */
function sameEdit(a: ActiveEdit | null, b: ActiveEdit | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.layerId === b.layerId &&
    a.text === b.text &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.align === b.align &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.lineHeight === b.lineHeight &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b &&
    a.color.a === b.color.a &&
    a.screenRect.x === b.screenRect.x &&
    a.screenRect.y === b.screenRect.y &&
    a.screenRect.width === b.screenRect.width &&
    a.screenRect.height === b.screenRect.height
  );
}

/** Build a TextLayerSnapshot from the active-edit descriptor. */
function snapshotFromActive(e: ActiveEdit): TextLayerSnapshot {
  return {
    text: e.text,
    fontFamily: e.fontFamily,
    fontSize: e.fontSize,
    color: { ...e.color },
    align: e.align,
    bold: e.bold,
    italic: e.italic,
    lineHeight: e.lineHeight,
    // Carry the path binding + warp so editing the TEXT of a path-bound/warped
    // layer doesn't wipe them when commitTextLayer rewrites the params wholesale.
    pathId: e.pathId,
    warp: e.warp ? { ...e.warp } : undefined,
  };
}

/** Structural equality of two text-layer snapshots. */
function sameSnapshot(a: TextLayerSnapshot, b: TextLayerSnapshot): boolean {
  return (
    a.text === b.text &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.align === b.align &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.lineHeight === b.lineHeight &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b &&
    a.color.a === b.color.a
  );
}
