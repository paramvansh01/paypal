import { describe, expect, it } from "vitest";
import { GeminiLlm, LlmError, RoutingLlm, type LlmRequest } from "../src/llm/client.js";
import { loadConfig } from "../src/config.js";

const req: LlmRequest = {
  model: "gemini-3.5-flash",
  system: "Judge narrowly.",
  content: [{ type: "text", text: "Is it a bakery?" }, { type: "image_png", base64: "iVBORw0KGgo=" }],
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
};

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("GeminiLlm", () => {
  it("sends system, text, image and the JSON schema, and returns the JSON text", async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const llm = new GeminiLlm("k-123", { fetch: fakeFetch(200, { modelVersion: "gemini-3.5-flash", candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"answer":"yes"}' }] } }] }, seen) });
    const res = await llm.complete(req);
    expect(res).toEqual({ text: '{"answer":"yes"}', model: "gemini-3.5-flash", stopReason: "STOP" });
    expect(seen[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
    expect((seen[0]!.init!.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-123");
    const body = JSON.parse(String(seen[0]!.init!.body));
    expect(body.systemInstruction.parts[0].text).toBe("Judge narrowly.");
    expect(body.contents[0].parts).toEqual([{ text: "Is it a bakery?" }, { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } }]);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema).toEqual(req.schema);
  });

  it("skips thought parts, and reports API errors, blocks and cut-offs as LlmError", async () => {
    const ok = new GeminiLlm("k", { fetch: fakeFetch(200, { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking", thought: true }, { text: "{}" }] } }] }) });
    expect((await ok.complete(req)).text).toBe("{}");
    await expect(new GeminiLlm("k", { fetch: fakeFetch(400, { error: { message: "bad key" } }) }).complete(req)).rejects.toThrow(/Gemini API error 400: bad key/);
    await expect(new GeminiLlm("k", { fetch: fakeFetch(200, { promptFeedback: { blockReason: "SAFETY" } }) }).complete(req)).rejects.toBeInstanceOf(LlmError);
    await expect(new GeminiLlm("k", { fetch: fakeFetch(200, { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }) }).complete(req)).rejects.toThrow(/cut off/);
  });
});

describe("RoutingLlm and config", () => {
  it("routes gemini-* to Google and the rest to Anthropic, and says which key is missing", async () => {
    const tag = (name: string) => ({ complete: async () => ({ text: name, model: name, stopReason: "STOP" }) });
    const both = new RoutingLlm({ anthropic: tag("anthropic"), gemini: tag("gemini") });
    expect((await both.complete(req)).text).toBe("gemini");
    expect((await both.complete({ ...req, model: "claude-haiku-5-5" })).text).toBe("anthropic");
    await expect(new RoutingLlm({ gemini: tag("gemini") }).complete({ ...req, model: "claude-opus-5-5" })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("uses Gemini models for drafts and judges when only a Gemini key is set", () => {
    const c = loadConfig({ GEMINI_API_KEY: "g", LLM_MODEL: "claude-opus-5-5" } as NodeJS.ProcessEnv);
    expect(c.llm.model).toMatch(/^gemini-/);
    expect(c.verifier.judgeModels.every((m) => m.startsWith("gemini-"))).toBe(true);
    const claude = loadConfig({ ANTHROPIC_API_KEY: "a" } as NodeJS.ProcessEnv);
    expect(claude.verifier.judgeModels).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });
});
