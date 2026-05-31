/**
 * ColorControls — the self-contained color section for the chrome.
 *
 * Combines the foreground/background swatches (which own the picker popover).
 * Designed to drop into the tool rail or a toolbar slot; it brings its own
 * spacing and is bound entirely to the engine color state via the swatches'
 * useColors() hook. Nothing here touches pixels.
 *
 * App should import { ColorControls } and mount it once (e.g. at the bottom of
 * the tool rail, or in the top toolbar).
 */
import { ColorSwatches } from "./ColorSwatches";

export function ColorControls() {
  return (
    <div className="flex items-center justify-center">
      <ColorSwatches />
    </div>
  );
}
