/**
 * OmniChrome — the only persistent UI in omni mode: two small, unobtrusive
 * floating clusters in the canvas corners. Everything else (tools, panels,
 * menus) is summoned via the omnibar / ⌘K.
 *
 *   top-left : document name · dimensions · zoom
 *   top-right: Tools · Layers · Export · credits · Classic-mode · ⌘K
 */
import {
  Sparkles,
  PencilRuler,
  Layers,
  Download,
  LayoutDashboard,
  Command,
  type LucideIcon,
} from "lucide-react";
import {
  useEngineSnapshot,
  useViewState,
} from "../state/useEngine";
import { engine } from "../state/useEngine";
import { exportPng } from "../engine/export";
import { useDocuments } from "../state/useEngine";
import { useWorkspace, workspaceStore } from "../state/workspace";
import { AccountWidget } from "./account/AccountWidget";

async function exportPngDownload() {
  const blob = await exportPng(engine);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ai-ps-export.png";
  a.click();
  URL.revokeObjectURL(url);
}

function PillButton({
  onClick,
  title,
  active,
  icon: Icon,
  label,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  icon: LucideIcon;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`pointer-events-auto flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium shadow-lg backdrop-blur transition-colors ${
        active
          ? "border-accent/60 bg-accent/20 text-ink"
          : "border-edge bg-panel/90 text-muted hover:bg-edge hover:text-ink"
      }`}
    >
      <Icon size={13} strokeWidth={2} />
      {label && <span>{label}</span>}
    </button>
  );
}

export function OmniChrome() {
  const ws = useWorkspace();
  const snap = useEngineSnapshot();
  const { zoom } = useViewState();
  const docs = useDocuments();
  const active = docs.documents.find((d) => d.active) ?? null;
  const hasLayers = snap.layers.length > 0;

  return (
    <>
      {/* top-left: document identity (subtle) */}
      <div className="animate-fadein pointer-events-none absolute left-3 top-3 z-30 flex items-center gap-2 rounded-md border border-edge bg-panel/80 py-1 pl-1.5 pr-2.5 text-[11px] text-muted shadow-lg backdrop-blur">
        <span className="flex h-4 w-4 items-center justify-center rounded bg-gradient-to-br from-accent to-fuchsia-500 text-white">
          <Sparkles size={10} strokeWidth={2.25} />
        </span>
        <span className="font-medium text-ink">{active?.name ?? "Untitled"}</span>
        {active && (
          <span className="tabular-nums">
            {active.width}×{active.height}
          </span>
        )}
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
      </div>

      {/* top-right: the essential summons */}
      <div className="animate-fadein pointer-events-none absolute right-3 top-3 z-30 flex items-center gap-1.5">
        <PillButton
          onClick={() => workspaceStore.openFloatingPanel("ai")}
          title="AI tools & assistant"
          active={ws.floatingPanel === "ai"}
          icon={Sparkles}
          label="AI"
        />
        <PillButton
          onClick={() => workspaceStore.toggleTools()}
          title="Tools"
          active={ws.toolsOpen}
          icon={PencilRuler}
          label="Tools"
        />
        <PillButton
          onClick={() => workspaceStore.openFloatingPanel("layers")}
          title="Layers"
          active={ws.floatingPanel === "layers"}
          icon={Layers}
          label="Layers"
        />
        {hasLayers && (
          <PillButton
            onClick={() => void exportPngDownload()}
            title="Export PNG"
            icon={Download}
            label="Export"
          />
        )}
        <div className="pointer-events-auto">
          <AccountWidget />
        </div>
        <PillButton
          onClick={() => workspaceStore.setMode("classic")}
          title="Classic docked workspace"
          icon={LayoutDashboard}
        />
        <PillButton
          onClick={() => workspaceStore.openPalette()}
          title="Command palette (⌘K)"
          icon={Command}
        />
      </div>
    </>
  );
}
