import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

/**
 * T3.1: the one way Kept talks to a language model. Every call asks for strict
 * JSON matching a schema (the API's structured outputs), so callers get data,
 * never free text to scrape. Two wrappers make it testable without a key:
 * RecordingLlm saves each response to a file, ReplayLlm serves them back.
 */

export type LlmContent = { type: "text"; text: string } | { type: "image_png"; base64: string };

export interface LlmRequest {
  model: string;
  system: string;
  content: LlmContent[];
  /** JSON Schema the answer must match (object at the top level). */
  schema: Record<string, unknown>;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  /**
   * Substrings that change on every call (like a canary). Replaced with a fixed
   * placeholder when computing the recording key, so a recorded response is
   * found again; replay substitutes the live value back into the response.
   */
  volatile?: string[];
}

export interface LlmResponse {
  /** Raw text the model returned (expected to be JSON). */
  text: string;
  model: string;
  stopReason: string | null;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LlmError";
  }
}

/** Parses the model's JSON. Throws LlmError on anything that is not a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new LlmError(`model output is not JSON: ${text.slice(0, 200)}`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new LlmError("model output is not a JSON object");
  return v as Record<string, unknown>;
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;
  constructor(apiKey: string, opts: { timeoutMs?: number; maxRetries?: number } = {}) {
    this.client = new Anthropic({ apiKey, timeout: opts.timeoutMs ?? 120_000, maxRetries: opts.maxRetries ?? 2 });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const content: Anthropic.ContentBlockParam[] = req.content.map((c) =>
      c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: "image/png", data: c.base64 } },
    );
    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 16_000,
        system: req.system,
        messages: [{ role: "user", content }],
        output_config: { effort: req.effort ?? "medium", format: { type: "json_schema", schema: req.schema } },
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error ${err.status ?? ""}: ${err.message}`, { cause: err });
      throw new LlmError(`Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (msg.stop_reason === "refusal") throw new LlmError(`the model declined (${msg.stop_details?.category ?? "no category"})`);
    if (msg.stop_reason === "max_tokens") throw new LlmError("the model's answer was cut off (max_tokens)");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, model: msg.model, stopReason: msg.stop_reason };
  }
}

/**
 * Google Gemini over its REST API (no SDK): generateContent with
 * responseMimeType application/json and responseJsonSchema, so answers are
 * strict JSON exactly as with Anthropic's structured outputs.
 */
export class GeminiLlm implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string; timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const base = this.opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{
        role: "user",
        parts: req.content.map((c) => (c.type === "text" ? { text: c.text } : { inlineData: { mimeType: "image/png", data: c.base64 } })),
      }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: req.schema, maxOutputTokens: req.maxTokens ?? 16_000 },
    };
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await f(`${base}/models/${encodeURIComponent(req.model)}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
        });
      } catch (err) {
        throw new LlmError(`Gemini request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      // Rate limits and overload are common on free tiers: retry twice with a short backoff.
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        continue;
      }
      break;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new LlmError(`Gemini API error ${res.status}: ${data?.error?.message ?? res.statusText}`);
    if (data?.promptFeedback?.blockReason) throw new LlmError(`the model declined (${data.promptFeedback.blockReason})`);
    const cand = data?.candidates?.[0];
    const reason: string | null = cand?.finishReason ?? null;
    if (reason === "MAX_TOKENS") throw new LlmError("the model's answer was cut off (max tokens)");
    if (reason && reason !== "STOP") throw new LlmError(`the model declined (${reason})`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (cand?.content?.parts ?? []).filter((p: any) => typeof p.text === "string" && !p.thought).map((p: any) => p.text).join("");
    return { text, model: data?.modelVersion ?? req.model, stopReason: reason };
  }
}

/** Sends each request to the provider its model name belongs to (gemini-* to Google, everything else to Anthropic). */
export class RoutingLlm implements LlmClient {
  constructor(private readonly clients: { anthropic?: LlmClient; gemini?: LlmClient }) {}
  complete(req: LlmRequest): Promise<LlmResponse> {
    const gemini = req.model.startsWith("gemini");
    const client = gemini ? this.clients.gemini : this.clients.anthropic;
    if (!client) return Promise.reject(new LlmError(`no API key for model ${req.model} (set ${gemini ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY"})`));
    return client.complete(req);
  }
}

const PLACEHOLDER = "<<VOLATILE>>";
const mask = (text: string, req: LlmRequest) => (req.volatile ?? []).reduce((acc, v) => (v ? acc.split(v).join(PLACEHOLDER) : acc), text);
const unmask = (text: string, req: LlmRequest) => (req.volatile?.[0] ? text.split(PLACEHOLDER).join(req.volatile[0]) : text);

/** Stable key for a request: everything that affects the answer, with volatile values masked. */
export function requestKey(req: LlmRequest): string {
  const body = JSON.stringify({
    model: req.model,
    system: mask(req.system, req),
    content: req.content.map((c) => (c.type === "text" ? { t: mask(c.text, req) } : { img: createHash("sha256").update(c.base64).digest("hex") })),
    schema: req.schema,
    effort: req.effort ?? "medium",
  });
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

interface Recording {
  key: string;
  model: string;
  /** Response text with volatile values masked. */
  text: string;
  stopReason: string | null;
}

/** Calls the real model and saves every response under `dir/<key>.json`. */
export class RecordingLlm implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.inner.complete(req);
    const key = requestKey(req);
    const rec: Recording = { key, model: res.model, text: mask(res.text, req), stopReason: res.stopReason };
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(rec, null, 2));
    return res;
  }
}

/** Serves recorded responses; an unrecorded request is an error (never a silent network call). */
export class ReplayLlm implements LlmClient {
  constructor(private readonly dir: string) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const file = join(this.dir, `${requestKey(req)}.json`);
    if (!existsSync(file)) throw new LlmError(`no recorded response for this request (${file})`);
    const rec = JSON.parse(readFileSync(file, "utf8")) as Recording;
    return { text: unmask(rec.text, req), model: rec.model, stopReason: rec.stopReason };
  }
}

/** A scripted model for tests: answers each request with a function of it. */
export class ScriptedLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  constructor(private readonly answer: (req: LlmRequest) => string | Promise<string>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    return { text: await this.answer(req), model: req.model, stopReason: "end_turn" };
  }
}

/**
 * Builds the client from config: a replay dir serves recordings, otherwise the
 * Anthropic API (recording too if a record dir is set). Undefined without a key.
 */
export function llmFromEnv(opts: { apiKey?: string; geminiApiKey?: string; replayDir?: string; recordDir?: string }): LlmClient | undefined {
  if (opts.replayDir) return new ReplayLlm(opts.replayDir);
  if (!opts.apiKey && !opts.geminiApiKey) return undefined;
  const live = new RoutingLlm({
    anthropic: opts.apiKey ? new AnthropicLlm(opts.apiKey) : undefined,
    gemini: opts.geminiApiKey ? new GeminiLlm(opts.geminiApiKey) : undefined,
  });
  return opts.recordDir ? new RecordingLlm(live, opts.recordDir) : live;
}
