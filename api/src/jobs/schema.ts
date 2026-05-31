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

const InpaintInputs = z.object({
  image: AssetRefSchema,
  mask: AssetRefSchema,
  prompt: z.string().min(1),
  mode: z.enum(["fill", "remove"]),
  roi: RectSchema,
  seed: z.number().int().optional(),
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
});

const RemoveBackgroundInputs = z.object({
  image: AssetRefSchema,
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
