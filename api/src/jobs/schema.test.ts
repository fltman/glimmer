import { describe, expect, it } from "vitest";
import {
  CreateJobRequestSchema,
  PresignUploadRequestSchema,
} from "./schema.js";

describe("CreateJobRequestSchema", () => {
  it("accepts a valid text_to_image request", () => {
    const result = CreateJobRequestSchema.safeParse({
      capability: "text_to_image",
      inputs: { prompt: "a red fox" },
      idempotencyKey: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects text_to_image with an empty prompt", () => {
    const result = CreateJobRequestSchema.safeParse({
      capability: "text_to_image",
      inputs: { prompt: "" },
      idempotencyKey: "abc123",
    });
    expect(result.success).toBe(false);
  });

  it("validates capability-specific inputs (inpaint requires a mask)", () => {
    const asset = {
      key: "u/dev/abc.png",
      sha256: "abc",
      contentType: "image/png",
    };
    const ok = CreateJobRequestSchema.safeParse({
      capability: "inpaint",
      inputs: {
        image: asset,
        mask: asset,
        prompt: "a hat",
        mode: "fill",
        roi: { x: 0, y: 0, width: 10, height: 10 },
      },
      idempotencyKey: "k",
    });
    expect(ok.success).toBe(true);

    const missingMask = CreateJobRequestSchema.safeParse({
      capability: "inpaint",
      inputs: {
        image: asset,
        prompt: "a hat",
        mode: "fill",
        roi: { x: 0, y: 0, width: 10, height: 10 },
      },
      idempotencyKey: "k",
    });
    expect(missingMask.success).toBe(false);
  });

  it("rejects an unknown capability", () => {
    const result = CreateJobRequestSchema.safeParse({
      capability: "teleport",
      inputs: {},
      idempotencyKey: "k",
    });
    expect(result.success).toBe(false);
  });
});

describe("PresignUploadRequestSchema", () => {
  it("accepts a valid upload request", () => {
    const result = PresignUploadRequestSchema.safeParse({
      sha256: "deadbeef",
      contentType: "image/png",
      byteLength: 1024,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-positive byteLength", () => {
    const result = PresignUploadRequestSchema.safeParse({
      sha256: "deadbeef",
      contentType: "image/png",
      byteLength: 0,
    });
    expect(result.success).toBe(false);
  });
});
