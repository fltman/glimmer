/**
 * Undo / redo history — a bounded command stack.
 *
 * Two flavours of command:
 *  - Structural / parametric ops (add/delete/reorder layer, opacity, blend mode,
 *    visibility, transform). These are cheap closures that re-apply the change;
 *    `bytes` ~ 0.
 *  - Pixel snapshots (brush/eraser/fill/mask edits). The command stores the
 *    affected region's previous pixels (RGBA8 or R8) and restores them on undo.
 *    `bytes` is the snapshot size; the stack is capped by total bytes.
 *
 * A command exposes `undo()` and `redo()`. The caller pushes AFTER applying the
 * forward change once (so the first redo is a no-op replay of the same state).
 */

export interface Command {
  /** Short label (used for menus / debugging). */
  label: string;
  /** Approximate retained bytes (for the byte cap). */
  bytes: number;
  undo(): void;
  redo(): void;
}

const DEFAULT_CAP_BYTES = 256 * 1024 * 1024; // 256 MB of pixel snapshots.

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private capBytes: number;
  private usedBytes = 0;
  private listeners = new Set<() => void>();

  constructor(capBytes = DEFAULT_CAP_BYTES) {
    this.capBytes = capBytes;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ── history list (for a History panel) ──────────────────
  /**
   * The full command list, oldest -> newest. `index` is the 0-based position of
   * each entry in this list; the cursor (see `currentIndex`) sits AFTER the
   * last applied command. The redo branch (commands ahead of the cursor) is the
   * reversed redo stack appended after the undo stack.
   */
  getEntries(): { label: string; index: number }[] {
    const out: { label: string; index: number }[] = [];
    let i = 0;
    for (const c of this.undoStack) out.push({ label: c.label, index: i++ });
    // redoStack is LIFO (top = next redo), so iterate it in reverse to get
    // chronological (oldest-redoable first) order.
    for (let k = this.redoStack.length - 1; k >= 0; k--) {
      out.push({ label: this.redoStack[k]!.label, index: i++ });
    }
    return out;
  }

  /**
   * The cursor position: the number of applied commands (== undoStack length).
   * An entry at list index `n` is "applied" iff n < currentIndex.
   */
  currentIndex(): number {
    return this.undoStack.length;
  }

  /**
   * Move the cursor so exactly `targetApplied` commands are applied (0 = fully
   * undone). Replays undo()/redo() one step at a time, so pixel-snapshot
   * commands restore correctly. Clamps to the valid range.
   */
  jumpTo(targetApplied: number): void {
    const total = this.undoStack.length + this.redoStack.length;
    const target = Math.max(0, Math.min(total, targetApplied));
    while (this.undoStack.length > target) {
      const cmd = this.undoStack.pop();
      if (!cmd) break;
      cmd.undo();
      this.usedBytes -= cmd.bytes;
      this.redoStack.push(cmd);
    }
    while (this.undoStack.length < target) {
      const cmd = this.redoStack.pop();
      if (!cmd) break;
      cmd.redo();
      this.usedBytes += cmd.bytes;
      this.undoStack.push(cmd);
    }
    this.emit();
  }

  /** Push a command whose forward action has ALREADY been applied. */
  push(cmd: Command): void {
    this.undoStack.push(cmd);
    this.usedBytes += cmd.bytes;
    // Pushing a new action invalidates the redo branch.
    this.redoStack.length = 0;
    this.trim();
    this.emit();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.usedBytes -= cmd.bytes;
    this.redoStack.push(cmd);
    this.emit();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.usedBytes += cmd.bytes;
    this.undoStack.push(cmd);
    this.emit();
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.usedBytes = 0;
    this.emit();
  }

  /** Drop the oldest commands until under the byte cap (keep >= 1). */
  private trim(): void {
    while (this.usedBytes > this.capBytes && this.undoStack.length > 1) {
      const dropped = this.undoStack.shift();
      if (dropped) this.usedBytes -= dropped.bytes;
    }
  }
}

/** Build a cheap parametric command from forward/back closures. */
export function paramCommand(
  label: string,
  apply: () => void,
  revert: () => void,
): Command {
  return { label, bytes: 0, undo: revert, redo: apply };
}
