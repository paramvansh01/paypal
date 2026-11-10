import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, missingKeys, requireConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults and treats blank values as unset", () => {
    const c = loadConfig({ PAYPAL_CLIENT_ID: "  ", PORT: "" });
    expect(c.paypal.clientId).toBeUndefined();
    expect(c.app.port).toBe(3000);
    expect(c.paypal.baseUrl).toBe("https://api-m.sandbox.paypal.com");
    expect(c.paypal.rail).toBe("delayed_disbursement");
    expect(c.verifier.browser).toBe("kernel");
  });

  it("rejects a live PayPal URL", () => {
    expect(() => loadConfig({ PAYPAL_BASE_URL: "https://api-m.paypal.com" })).toThrow(/PAYPAL_BASE_URL/);
  });

  it("names the key with a bad value", () => {
    try {
      loadConfig({ PAYMENT_RAIL: "bitcoin" });
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).keys).toEqual(["PAYMENT_RAIL"]);
    }
  });
});

describe("requireConfig", () => {
  it("names every missing key in the requested groups", () => {
    const c = loadConfig({ PAYPAL_CLIENT_ID: "id", VERIFIER_BROWSER: "local" });
    expect(() => requireConfig(c, "paypal", "llm")).toThrow(
      /PAYPAL_CLIENT_SECRET, PAYPAL_PARTNER_ATTRIBUTION_ID, PAYPAL_PARTNER_MERCHANT_ID, ANTHROPIC_API_KEY, LLM_MODEL/,
    );
    expect(missingKeys(c, "verifier")).toEqual([]);
  });

  it("does not need partner keys on the auth_capture rail", () => {
    const c = loadConfig({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s", PAYMENT_RAIL: "auth_capture" });
    expect(() => requireConfig(c, "paypal")).not.toThrow();
  });
});

describe("quorum settings", () => {
  it("defaults to 2-of-3 with three judge models", () => {
    const c = loadConfig({});
    expect(c.verifier).toMatchObject({ quorumN: 3, quorumK: 2 });
    expect(c.verifier.judgeModels).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  });

  it("requires k to be a strict majority of n", () => {
    expect(() => loadConfig({ QUORUM_N: "4", QUORUM_K: "2" })).toThrow(/more than half/);
    expect(() => loadConfig({ QUORUM_N: "3", QUORUM_K: "4" })).toThrow(/at most QUORUM_N/);
    expect(loadConfig({ QUORUM_N: "5", QUORUM_K: "3" }).verifier.quorumK).toBe(3);
    expect(loadConfig({ QUORUM_N: "1", QUORUM_K: "1" }).verifier.quorumN).toBe(1);
  });

  it("parses a custom judge model list", () => {
    expect(loadConfig({ JUDGE_MODELS: " a , b " }).verifier.judgeModels).toEqual(["a", "b"]);
  });
});
