/**
 * GENERATE — text-to-image. Builds a text_to_image job and drops the result as
 * a new layer. Uses the shared useAiJob lifecycle hook.
 */
import { useState } from "react";
import type { CreateJobRequest } from "@aips/shared-types";
import { idempotencyKey } from "../apiClient";
import { engine } from "../../state/useEngine";
import { useAiJob } from "../useAiJob";
import { Field, JobStatus } from "../AiSectionShell";

const SIZES = [
  { label: "Square 1024", w: 1024, h: 1024 },
  { label: "Portrait 832×1216", w: 832, h: 1216 },
  { label: "Landscape 1216×832", w: 1216, h: 832 },
] as const;

export function GenerateSection() {
  const [prompt, setPrompt] = useState("");
  const [sizeIdx, setSizeIdx] = useState(0);
  const job = useAiJob();

  async function onGenerate() {
    if (!prompt.trim() || job.busy) return;
    const size = SIZES[sizeIdx]!;
    const inputs = { prompt: prompt.trim(), width: size.w, height: size.h };
    const key = await idempotencyKey({ capability: "text_to_image", inputs });
    const req: CreateJobRequest<"text_to_image"> = {
      capability: "text_to_image",
      inputs,
      qualityTier: "quality",
      idempotencyKey: key,
    };
    await job.run(req, {
      onArtifact: async (blob, art) => {
        const name =
          art.placement?.suggestedLayerName ??
          (prompt.slice(0, 40).trim() || "AI image");
        await engine.loadImageLayer(blob, name);
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="A neon-lit rainy Tokyo alley, cinematic, 35mm"
          className="resize-none rounded-md border border-edge bg-panelraised px-2.5 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
      </Field>

      <Field label="Size">
        <select
          value={sizeIdx}
          onChange={(e) => setSizeIdx(Number(e.target.value))}
          className="rounded-md border border-edge bg-panelraised px-2.5 py-1.5 text-sm outline-none focus:border-accent"
        >
          {SIZES.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>

      <button
        className="btn btn-accent justify-center py-2"
        onClick={onGenerate}
        disabled={job.busy || !prompt.trim()}
      >
        {job.busy ? "Generating…" : "Generate"}
      </button>

      <JobStatus {...job} />
    </div>
  );
}
