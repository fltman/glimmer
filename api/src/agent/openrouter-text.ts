/**
 * Minimal OpenRouter TEXT (chat completions) client for agent planning.
 *
 * Mirrors the worker's image provider transport (Bearer auth + attribution
 * headers + /chat/completions) but for the text model and with JSON-mode
 * requested. The provider key is read from server-side config and NEVER
 * leaves this process. Errors are normalized to `OpenRouterTextError` so the
 * route can map them to clean HTTP responses (502 on provider failure).
 */
import { config } from "../config.js";

/** Normalized provider failure. `status` is the HTTP status we should surface. */
export class OpenRouterTextError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = "OpenRouterTextError";
    this.code = code;
    this.status = status;
  }
}

/** Wall-clock budget for the planning call. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * A multimodal content part. Text-only messages may pass a plain string for
 * `content`; messages that carry an image use the OpenAI-shaped parts array
 * (`{type:"text"}` / `{type:"image_url", image_url:{url}}`). The image url is a
 * `data:` URL (base64) so no bytes leave this process unsigned.
 */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}

/**
 * Call the configured text model with the given messages and return the
 * assistant's text content. Requests `response_format: json_object` so the
 * model returns parseable JSON; callers still defensively parse.
 *
 * Messages may be multimodal (text + image parts): the configured
 * `OPENROUTER_TEXT_MODEL` default (google/gemini-2.5-flash) accepts images, so
 * vision endpoints (e.g. /ai/analyze-distractions) share this transport.
 */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const baseUrl = config.openrouter.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
        // OpenRouter attribution headers (optional but recommended).
        "HTTP-Referer": "https://ai-ps.local",
        "X-Title": "ai-ps",
      },
      body: JSON.stringify({
        model: config.openrouter.textModel,
        messages,
        // Constrain output to plain text (we ask for JSON in the prompt and
        // request JSON mode; models that ignore it still return text we parse).
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new OpenRouterTextError(
      aborted ? "provider_timeout" : "provider_network_error",
      aborted
        ? `OpenRouter text request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : `OpenRouter text request failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 429) {
    throw new OpenRouterTextError(
      "provider_rate_limited",
      "OpenRouter rate limited (429)",
    );
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, 300);
    throw new OpenRouterTextError(
      "provider_error",
      `OpenRouter ${resp.status}: ${detail}`,
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    throw new OpenRouterTextError(
      "provider_bad_response",
      "OpenRouter returned non-JSON",
    );
  }

  const content = extractContent(data);
  if (content === null) {
    throw new OpenRouterTextError(
      "provider_bad_response",
      "OpenRouter response had no assistant message content",
    );
  }
  return content;
}

/**
 * Pull the assistant text out of an OpenAI-shaped chat completion. Content may
 * be a plain string or an array of content parts ({type:"text", text}); we
 * concatenate text parts to be robust across model providers.
 */
function extractContent(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;

  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
    return text.length > 0 ? text : null;
  }
  return null;
}
