/**
 * Presigned upload route.
 *
 *   POST /storage/presign-upload — given a content hash + type + size, return
 *   a presigned PUT URL (or signal a dedup hit if the object already exists).
 *
 * Pixel payloads go straight to MinIO via this URL, avoiding base64 inflation
 * through the API. Keys are content-addressed (sha256) so identical bytes are
 * deduped per user.
 */
import type { FastifyPluginAsync } from "fastify";
import type { PresignUploadResponse } from "@aips/shared-types";
import { getUserId } from "../auth.js";
import { PresignUploadRequestSchema } from "../jobs/schema.js";
import { buildKey, objectExists, presignPut } from "../storage.js";

/** Map common image content types to a file extension. */
function extFor(contentType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/avif": "avif",
    "application/octet-stream": "bin",
  };
  return map[contentType] ?? "bin";
}

export const presignRoutes: FastifyPluginAsync = async (app) => {
  app.post("/storage/presign-upload", async (request, reply) => {
    const parsed = PresignUploadRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid_request", issues: parsed.error.issues });
    }
    const { sha256, contentType } = parsed.data;
    const userId = getUserId(request);
    const key = buildKey(userId, sha256, extFor(contentType));

    // Dedup: if the bytes are already stored, the client skips the PUT.
    if (await objectExists(key)) {
      const response: PresignUploadResponse = {
        alreadyExists: true,
        key,
        uploadUrl: null,
        requiredHeaders: {},
      };
      return reply.send(response);
    }

    const uploadUrl = await presignPut(key, contentType);
    const response: PresignUploadResponse = {
      alreadyExists: false,
      key,
      uploadUrl,
      // The PUT must carry the same Content-Type that was signed.
      requiredHeaders: { "Content-Type": contentType },
    };
    return reply.send(response);
  });
};
