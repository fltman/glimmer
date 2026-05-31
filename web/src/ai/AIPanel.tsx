/**
 * AI panel — the right-hand action surface, organized into tabs:
 *   ASSISTANT (chat: conversational whole-image edits, prompt-to-layer, and
 *   Auto-edit multi-step planning) · GENERATE (text-to-image) · EDIT (inpaint +
 *   reference-image fill) · HARMONIZE (relight/grade a subject into the scene) ·
 *   RELIGHT (directional/colored AI relighting) · COLOR MATCH (transfer a
 *   reference image's grade — local Lab transfer) · CUTOUT (remove bg) ·
 *   EXPAND (outpaint) · UPSCALE · PRESETS (one-click local cinematic looks).
 *
 * Each tab is a self-contained section that owns its own job lifecycle via the
 * shared useAiJob() hook (submit → WS progress → fetch artifact → loadLayer).
 * The provider key stays on the server; the browser only ever sees presigned
 * URLs — except CUTOUT, which can run RMBG-1.4 entirely client-side. ASSISTANT
 * additionally talks to the synchronous planner at POST /ai/agent.
 */
import { useState } from "react";
import { AssistantPanel } from "./assistant/AssistantPanel";
import { GenerateSection } from "./sections/GenerateSection";
import { EditSection } from "./sections/EditSection";
import { HarmonizeSection } from "./harmonize/HarmonizeSection";
import { RelightSection } from "./sections/RelightSection";
import { ColorMatchSection } from "./sections/ColorMatchSection";
import { ReflectionSection } from "./sections/ReflectionSection";
import { CutoutSection } from "./sections/CutoutSection";
import { DistractionsSection } from "./distractions/DistractionsSection";
import { ExpandSection } from "./sections/ExpandSection";
import { UpscaleSection } from "./sections/UpscaleSection";
import { PresetsSection } from "./presets/PresetsSection";

type TabId =
  | "assistant"
  | "generate"
  | "edit"
  | "harmonize"
  | "relight"
  | "colormatch"
  | "reflection"
  | "cutout"
  | "distractions"
  | "expand"
  | "upscale"
  | "presets";

const TABS: { id: TabId; label: string }[] = [
  { id: "assistant", label: "Assistant" },
  { id: "generate", label: "Generate" },
  { id: "edit", label: "Edit" },
  { id: "harmonize", label: "Harmonize" },
  { id: "relight", label: "Relight" },
  { id: "colormatch", label: "Color Match" },
  { id: "reflection", label: "Reflections" },
  { id: "cutout", label: "Cutout" },
  { id: "distractions", label: "Cleanup" },
  { id: "expand", label: "Expand" },
  { id: "upscale", label: "Upscale" },
  { id: "presets", label: "Presets" },
];

export function AIPanel() {
  const [tab, setTab] = useState<TabId>("assistant");

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

      {/* Active section. The Assistant manages its own scroll + sticky composer,
          so it gets the full height (just horizontal padding); the form-based
          sections keep the scrolling, padded wrapper. */}
      {tab === "assistant" ? (
        <div className="min-h-0 flex-1 px-3">
          <AssistantPanel />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "generate" && <GenerateSection />}
          {tab === "edit" && <EditSection />}
          {tab === "harmonize" && <HarmonizeSection />}
          {tab === "relight" && <RelightSection />}
          {tab === "colormatch" && <ColorMatchSection />}
          {tab === "reflection" && <ReflectionSection />}
          {tab === "cutout" && <CutoutSection />}
          {tab === "distractions" && <DistractionsSection />}
          {tab === "expand" && <ExpandSection />}
          {tab === "upscale" && <UpscaleSection />}
          {tab === "presets" && <PresetsSection />}
        </div>
      )}
    </div>
  );
}
