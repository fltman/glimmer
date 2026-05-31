/**
 * Zod schemas mirroring the wire shapes in @aips/shared-types.
 *
 * The TS types are the source of truth for shape; these schemas are the
 * runtime gate at the HTTP boundary. Keep them in lock-step with index.ts.
 */
import { z } from "zod";
import { CAPABILITIES } from "@aips/shared-types";

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const AssetRefSchema = z.object({
  key: z.string().min(1),
  sha256: z.string().min(1),
  contentType: z.string().min(1),
  width: z.number().optional(),
  height: z.number().optional(),
});

// ── Per-capability input schemas ──────────────────────────────

const TextToImageInputs = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  seed: z.number().int().optional(),
});

const ImageEditInputs = z.object({
  image: AssetRefSchema,
  instruction: z.string().min(1),
  seed: z.number().int().optional(),
});

const InpaintInputs = z
  .object({
    image: AssetRefSchema,
    mask: AssetRefSchema,
    // Prompt may be empty when a referenceImage drives the fill; the cross-field
    // refine below enforces "at least one of prompt/referenceImage for fill".
    prompt: z.string(),
    mode: z.enum(["fill", "remove"]),
    roi: RectSchema,
    /** Optional reference image for identity-preserving generative fill. */
    referenceImage: AssetRefSchema.optional(),
    seed: z.number().int().optional(),
  })
  .superRefine((val, ctx) => {
    // A "fill" needs *something* to fill with: either a text prompt or a
    // reference image. "remove" needs neither.
    if (val.mode === "fill" && val.prompt.trim().length === 0 && !val.referenceImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: "inpaint mode 'fill' requires a non-empty 'prompt' or a 'referenceImage'",
      });
    }
  });

const OutpaintInputs = z.object({
  image: AssetRefSchema,
  expand: z.object({
    top: z.number().int().nonnegative(),
    right: z.number().int().nonnegative(),
    bottom: z.number().int().nonnegative(),
    left: z.number().int().nonnegative(),
  }),
  prompt: z.string().optional(),
  seed: z.number().int().optional(),
});

const SegmentInputs = z.object({
  image: AssetRefSchema,
  points: z
    .array(
      z.object({
        x: z.number(),
        y: z.number(),
        label: z.union([z.literal(0), z.literal(1)]),
      }),
    )
    .optional(),
  box: RectSchema.optional(),
});

const UpscaleInputs = z.object({
  image: AssetRefSchema,
  scale: z.union([z.literal(2), z.literal(4)]),
  /** 0..1 creative-enhance strength applied after the base upscale. */
  creativity: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
});

const RemoveBackgroundInputs = z.object({
  image: AssetRefSchema,
});

const HarmonizeInputs = z.object({
  /** Inserted subject as an RGBA cutout (alpha defines the silhouette). */
  foreground: AssetRefSchema,
  /** Flattened composite of the layers below the subject (same size). */
  background: AssetRefSchema,
  /** Optional ROI the subject occupies, for placing the result back. */
  roi: RectSchema.optional(),
  /** 0..1 relight/grade aggressiveness. */
  strength: z.number().min(0).max(1).optional(),
  seed: z.number().int().optional(),
});

/**
 * Discriminated request schema. We validate `inputs` against the matching
 * per-capability schema via a refine + transform so the parsed result is
 * correctly typed downstream.
 */
const CAPABILITY_INPUTS = {
  text_to_image: TextToImageInputs,
  image_edit: ImageEditInputs,
  inpaint: InpaintInputs,
  outpaint: OutpaintInputs,
  segment: SegmentInputs,
  upscale: UpscaleInputs,
  remove_background: RemoveBackgroundInputs,
  harmonize: HarmonizeInputs,
} as const;

export const CreateJobRequestSchema = z
  .object({
    capability: z.enum(CAPABILITIES),
    inputs: z.unknown(),
    documentId: z.string().optional(),
    qualityTier: z.enum(["fast", "quality"]).optional(),
    preferLocation: z.enum(["server", "client"]).optional(),
    idempotencyKey: z.string().min(1),
  })
  .superRefine((val, ctx) => {
    const schema = CAPABILITY_INPUTS[val.capability];
    const result = schema.safeParse(val.inputs);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["inputs", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

export const PresignUploadRequestSchema = z.object({
  sha256: z.string().min(1),
  contentType: z.string().min(1),
  byteLength: z.number().int().positive(),
});

export const JobIdParamsSchema = z.object({
  id: z.string().min(1),
});
