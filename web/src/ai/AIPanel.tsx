/**
 * AI panel — the AI action surface. Instead of a wall of 12 cryptic tabs, it
 * leads with the Assistant (describe anything; it routes or plans) and presents
 * the specific tools as a clean, categorized launcher: each is a card with an
 * icon, a name, and a one-line description, so they're browsable rather than
 * guessed at. Picking a tool opens its panel; "⊞ Tools" / the back arrow return
 * to the launcher.
 *
 * Each tool section owns its own job lifecycle via useAiJob() (submit → WS
 * progress → fetch artifact → loadLayer); the provider key stays on the server
 * (browser sees only presigned URLs), except CUTOUT which can run RMBG-1.4
 * client-side. ASSISTANT also talks to the synchronous planner at POST /ai/agent.
 *
 * `aiTab` is controlled by the workspace store so the ⌘K palette can deep-link a
 * specific tool; a local `view` toggles between that tool and the launcher grid.
 */
import { useEffect, useState } from "react";
import { useWorkspace, workspaceStore } from "../state/workspace";
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

interface ToolMeta {
  label: string;
  icon: string;
  desc: string;
}

const META: Record<TabId, ToolMeta> = {
  assistant: { label: "Assistant", icon: "✦", desc: "Describe any edit — I'll do it or plan the steps." },
  generate: { label: "Generate", icon: "🖼️", desc: "Make a brand-new image from a text prompt." },
  expand: { label: "Expand", icon: "⛶", desc: "Outpaint — extend the scene past the edges." },
  edit: { label: "Edit", icon: "✏️", desc: "Change a region (or all) by describing it." },
  relight: { label: "Relight", icon: "🔆", desc: "Relight from a chosen direction & colour." },
  colormatch: { label: "Color Match", icon: "🎨", desc: "Match the grade of a reference image." },
  cutout: { label: "Cutout", icon: "✂️", desc: "Remove the background to a clean cutout." },
  reflection: { label: "Reflections", icon: "🪟", desc: "Erase glass glare & reflections." },
  distractions: { label: "Cleanup", icon: "🧹", desc: "Find & remove distracting elements." },
  harmonize: { label: "Harmonize", icon: "🩹", desc: "Blend a pasted subject into the scene." },
  upscale: { label: "Upscale", icon: "🔍", desc: "Increase resolution, adding fine detail." },
  presets: { label: "Presets", icon: "🎞️", desc: "One-click cinematic colour looks." },
};

const GROUPS: { name: string; items: TabId[] }[] = [
  { name: "Create", items: ["generate", "expand"] },
  { name: "Light & colour", items: ["edit", "relight", "colormatch"] },
  { name: "Retouch & remove", items: ["cutout", "reflection", "distractions", "harmonize"] },
  { name: "Enhance", items: ["upscale", "presets"] },
];

/** The launcher: a hero "Assistant" entry + categorized tool cards. */
function ToolLauncher({ onPick }: { onPick: (id: TabId) => void }) {
  const card = (id: TabId) => {
    const m = META[id];
    return (
      <button
        key={id}
        onClick={() => onPick(id)}
        className="group flex items-start gap-2.5 rounded-lg border border-edge bg-panelraised/50 p-2.5 text-left transition-colors hover:border-accent/60 hover:bg-panelraised"
      >
        <span className="text-base leading-none">{m.icon}</span>
        <span className="min-w-0">
          <span className="block text-xs font-semibold text-ink">{m.label}</span>
          <span className="mt-0.5 block text-[10px] leading-snug text-muted">
            {m.desc}
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Assistant hero */}
      <button
        onClick={() => onPick("assistant")}
        className="flex items-center gap-3 rounded-xl border border-accent/40 bg-gradient-to-br from-accent/15 to-fuchsia-500/10 p-3 text-left transition-colors hover:from-accent/25 hover:to-fuchsia-500/15"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-fuchsia-500 text-lg text-white shadow">
          ✦
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">Assistant</span>
          <span className="block text-[11px] leading-snug text-muted">
            Just describe what you want — it edits, generates, or plans the steps.
          </span>
        </span>
      </button>

      {GROUPS.map((g) => (
        <div key={g.name}>
          <div className="mb-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
            {g.name}
          </div>
          <div className="grid grid-cols-2 gap-1.5">{g.items.map(card)}</div>
        </div>
      ))}
    </div>
  );
}

export function AIPanel() {
  const tab = useWorkspace().aiTab as TabId;
  const setTab = (t: TabId) => workspaceStore.setAiTab(t);
  // "home" = the tool launcher; "tool" = the active tool's panel.
  const [view, setView] = useState<"home" | "tool">("tool");

  // A ⌘K deep-link (external aiTab change) jumps straight into that tool.
  useEffect(() => setView("tool"), [tab]);

  const pick = (id: TabId) => {
    setTab(id);
    setView("tool");
  };

  const onHome = view === "home";
  const title = onHome ? "AI tools" : META[tab].label;

  return (
    <div className="flex h-full flex-col">
      {/* Slim header: context on the left, launcher toggle on the right. */}
      <div className="flex shrink-0 items-center justify-between border-b border-edge px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {!onHome && tab !== "assistant" && (
            <button
              onClick={() => setView("home")}
              title="Back to AI tools"
              className="rounded px-1 text-muted hover:bg-panelraised hover:text-ink"
            >
              ←
            </button>
          )}
          <span className="truncate text-xs font-semibold text-ink">{title}</span>
        </div>
        <button
          onClick={() => setView(onHome ? "tool" : "home")}
          className={`rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors ${
            onHome
              ? "border-accent/50 bg-accent/15 text-ink"
              : "border-edge text-muted hover:bg-panelraised hover:text-ink"
          }`}
        >
          {onHome ? "Done" : "⊞ Tools"}
        </button>
      </div>

      {/* Body: launcher, assistant (full height), or a tool section (scrolled). */}
      {onHome ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <ToolLauncher onPick={pick} />
        </div>
      ) : tab === "assistant" ? (
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
