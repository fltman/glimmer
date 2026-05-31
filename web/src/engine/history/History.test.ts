import { describe, it, expect } from "vitest";
import { History, paramCommand } from "./History";

describe("History", () => {
  it("undo/redo restores and re-applies state", () => {
    let v = 0;
    const h = new History();
    v = 1;
    h.push(paramCommand("set 1", () => (v = 1), () => (v = 0)));
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);

    h.undo();
    expect(v).toBe(0);
    expect(h.canRedo()).toBe(true);

    h.redo();
    expect(v).toBe(1);
  });

  it("a new push clears the redo branch", () => {
    let v = 0;
    const h = new History();
    h.push(paramCommand("a", () => (v = 1), () => (v = 0)));
    h.undo();
    expect(h.canRedo()).toBe(true);
    h.push(paramCommand("b", () => (v = 2), () => (v = 0)));
    expect(h.canRedo()).toBe(false);
  });

  it("trims oldest pixel snapshots over the byte cap (keeps >= 1)", () => {
    const h = new History(10); // 10-byte cap
    const mk = (bytes: number) => ({
      label: "snap",
      bytes,
      undo: () => {},
      redo: () => {},
    });
    h.push(mk(6));
    h.push(mk(6)); // 12 > 10 -> drop the first
    // Only the most recent remains undoable; the trimmed one is gone.
    h.undo();
    expect(h.canUndo()).toBe(false);
  });
});
