/**
 * A referentially-stable callback that always invokes the latest closure.
 *
 * Useful for long-lived event listeners (e.g. window `pointermove` during a
 * Navigator drag) that should call the freshest props/state without being
 * re-bound on every render.
 */
import { useCallback, useLayoutEffect, useRef } from "react";

export function useCallbackRef<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}
