/**
 * AdjustmentsPanel — self-contained panel App mounts. Shows the
 * AddAdjustmentMenu, and when the active layer is an adjustment layer, its
 * AdjustmentProperties (which themselves embed the Curves/Levels editors). Reads
 * the engine snapshot reactively; never touches pixels.
 */
import { useEngineSnapshot } from "../../state/useEngine";
import { AddAdjustmentMenu } from "./AddAdjustmentMenu";
import { AdjustmentProperties } from "./AdjustmentProperties";

export function AdjustmentsPanel() {
  const snap = useEngineSnapshot();
  const active = snap.layers.find((l) => l.id === snap.activeLayerId) ?? null;
  const isAdjustment = active?.kind === "adjustment";

  return (
    <div className="flex h-full flex-col">
      <div className="panel-title border-b border-edge">Adjustments</div>
      <div className="border-b border-edge p-2">
        <AddAdjustmentMenu />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isAdjustment && active ? (
          <AdjustmentProperties key={active.id} layer={active} />
        ) : (
          <p className="px-3 py-4 text-xs leading-relaxed text-muted">
            Add an adjustment layer to tune the layers below it
            non-destructively. Select an existing adjustment layer to edit its
            settings here.
          </p>
        )}
      </div>
    </div>
  );
}
