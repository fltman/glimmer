/**
 * Distraction analyzer route.
 *
 *   POST /ai/analyze-distractions  — synchronous (mirrors POST /ai/agent; it is
 *     NOT the job queue). Takes { image: AssetRef }, downloads the object bytes
 *     server-side from MinIO, base64-data-URL-encodes them, sends them to the
 *     OpenRouter MULTIMODAL text model, and returns { distractions } directly.
 *
 * The provider key never leaves this process and the image bytes never transit
 * the browser unsigned — the API reads the object via its internal S3 client.
 * The returned boxes are NORMALIZED [0,1] image coordinates; the user reviews
 * and adjusts the selection before anything is removed.
 */
import type { FastifyPluginAsync } from "fastify";
import { nanoid } from "nanoid";
import type { AnalyzeDistractionsResponse } from "@aips/shared-types";
import { getObjectBytes } from "../storage.js";
import { chatCompletion, OpenRouterTextError } from "../agent/openrouter-text.js";
import { config } from "../config.js";
import { getUserId, requireAuth } from "../auth.js";
import { InsufficientCredits, refundAll, reserve, settle } from "../credits/ledger.js";
import { routeRateLimit } from "../ratelimit.js";
import { buildDistractionMessages } from "./prompt.js";
import {
  AnalyzeDistractionsRequestSchema,
  RawDistractionsSchema,
  coerceDistractions,
} from "./schema.js";

/** Cap on bytes we will base64-encode and send inline to the vision model. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MiB

/**
 * Extract a JSON object from a model response. Handles the common cases where
 * the model wraps JSON in ```json fences or adds stray prose before/after.
 * (Mirrors the agent route's parseModelJson.)
 */
function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new SyntaxError("no JSON object found in model response");
}

export const distractionRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    "/ai/analyze-distractions",
    {
      preHandler: requireAuth,
      config: { rateLimit: routeRateLimit(config.rateLimit.syncPerMin) },
    },
    async (request, reply) => {
    const parsed = AnalyzeDistractionsRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const { image } = parsed.data;
    const userId = getUserId(request);

    // Flat reserve → settle/refund (synchronous vision call; synthetic job id).
    const syncJobId = `sync:${nanoid()}`;
    const cost = config.credits.syncDistractionsCost;
    try {
      await reserve(userId, syncJobId, cost);
    } catch (err) {
      if (err instanceof InsufficientCredits) {
        return reply.code(402).send({
          error: "insufficient_credits",
          message: "Not enough credits for distraction analysis",
          required: err.required,
          balance: err.balance,
        });
      }
      throw err;
    }
    // Helper: refund the reservation on any pre-/non-provider failure path.
    const refund = (reason: string): Promise<void> =>
      refundAll({ jobId: syncJobId, userId, capability: "distractions", reason });

    const startedAt = Date.now();

    // 1) read the image bytes server-side (internal S3 endpoint).
    let bytes: Buffer;
    try {
      bytes = await getObjectBytes(image.key);
    } catch (err) {
      await refund("storage read error");
      request.log.warn(
        { err, key: image.key },
        "analyze-distractions: could not read image object",
      );
      return reply.code(502).send({
        error: "storage_error",
        message: "Could not read the image from storage",
      });
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      await refund("image too large");
      return reply.code(413).send({
        error: "image_too_large",
        message: `Image exceeds the ${MAX_IMAGE_BYTES} byte analysis limit`,
      });
    }

    // 2) build a base64 data URL (use the asset's contentType, default png).
    const contentType =
      image.contentType && image.contentType.startsWith("image/")
        ? image.contentType
        : "image/png";
    const dataUrl = `data:${contentType};base64,${bytes.toString("base64")}`;

    // 3) call the multimodal text model.
    const messages = buildDistractionMessages(dataUrl);
    let raw: string;
    try {
      raw = await chatCompletion(messages);
    } catch (err) {
      // Provider failed → refund (user wasn't served).
      await refund("distractions provider error");
      if (err instanceof OpenRouterTextError) {
        request.log.warn(
          { code: err.code, msg: err.message },
          "analyze-distractions provider error",
        );
        return reply
          .code(err.status)
          .send({ error: err.code, message: err.message });
      }
      request.log.error({ err }, "analyze-distractions unexpected error");
      return reply.code(502).send({
        error: "analyzer_failed",
        message: "Distraction analyzer failed",
      });
    }
    // Provider succeeded → settle the flat cost (records ai_usage).
    await settle({
      jobId: syncJobId,
      userId,
      capability: "distractions",
      model: config.openrouter.textModel,
      rawCostUsd: null,
      latencyMs: Date.now() - startedAt,
    });

    // 4) parse + validate + sanitize the model's JSON.
    let candidate: unknown;
    try {
      candidate = parseModelJson(raw);
    } catch {
      request.log.warn(
        { raw: raw.slice(0, 500) },
        "analyze-distractions returned non-JSON",
      );
      return reply.code(502).send({
        error: "analyzer_bad_output",
        message: "Distraction analyzer did not return valid JSON",
      });
    }

    const rawResult = RawDistractionsSchema.safeParse(candidate);
    if (!rawResult.success) {
      request.log.warn(
        { issues: rawResult.error.issues },
        "analyze-distractions JSON did not match expected shape",
      );
      return reply.code(502).send({
        error: "analyzer_bad_output",
        message: "Distraction analyzer returned a malformed result",
      });
    }

    const { distractions, dropped } = coerceDistractions(rawResult.data);
    if (dropped > 0) {
      request.log.info(
        { dropped },
        "dropped malformed distraction regions",
      );
    }

    // 5) build the response. "Nothing found" → empty list + a friendly note.
    const response: AnalyzeDistractionsResponse = {
      distractions,
      ...(distractions.length === 0
        ? {
            message:
              rawResult.data.message?.trim() ||
              "No obvious distractions found.",
          }
        : rawResult.data.message?.trim()
          ? { message: rawResult.data.message.trim() }
          : {}),
    };
    return reply.send(response);
    },
  );
};
