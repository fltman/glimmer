/**
 * AI panel — the right-hand action surface, organized into tabs:
 *   GENERATE (text-to-image) · EDIT (inpaint + reference-image fill) ·
 *   HARMONIZE (relight/grade a subject into the scene) · CUTOUT (remove bg) ·
 *   EXPAND (outpaint) · UPSCALE.
 *
 * Each tab is a self-contained section that owns its own job lifecycle via the
 * shared useAiJob() hook (submit → WS progress → fetch artifact → loadLayer).
 * The provider key stays on the server; the browser only ever sees presigned
 * URLs — except CUTOUT, which can run RMBG-1.4 entirely client-side.
 */
import { useState } from "react";
import { GenerateSection } from "./sections/GenerateSection";
import { EditSection } from "./sections/EditSection";
import { HarmonizeSection } from "./harmonize/HarmonizeSection";
import { CutoutSection } from "./sections/CutoutSection";
import { ExpandSection } from "./sections/ExpandSection";
import { UpscaleSection } from "./sections/UpscaleSection";

type TabId =
  | "generate"
  | "edit"
  | "harmonize"
  | "cutout"
  | "expand"
  | "upscale";

const TABS: { id: TabId; label: string }[] = [
  { id: "generate", label: "Generate" },
  { id: "edit", label: "Edit" },
  { id: "harmonize", label: "Harmonize" },
  { id: "cutout", label: "Cutout" },
  { id: "expand", label: "Expand" },
  { id: "upscale", label: "Upscale" },
];

export function AIPanel() {
  const [tab, setTab] = useState<TabId>("generate");

  return (
    <div className="flex h-full flex-col">
      {/* Tab strip */}
      <div className="flex flex-wrap gap-1 border-b border-edge px-2 py-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
              tab === t.id
                ? "bg-accent text-white"
                : "text-muted hover:bg-panelraised hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Active section */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "generate" && <GenerateSection />}
        {tab === "edit" && <EditSection />}
        {tab === "harmonize" && <HarmonizeSection />}
        {tab === "cutout" && <CutoutSection />}
        {tab === "expand" && <ExpandSection />}
        {tab === "upscale" && <UpscaleSection />}
      </div>
    </div>
  );
}
