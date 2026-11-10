import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

/**
 * Typed configuration loaded from environment variables (see .env.example).
 *
 * Values are grouped by the service that needs them. `loadConfig` only
 * validates formats, so the server can boot without every secret. Code that
 * needs a service calls `requireConfig(config, "paypal")` (or another group),
 * which throws a message naming every missing key in that group.
 */

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

const EnvSchema = z.object({
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_BASE_URL: z.preprocess(
    blankToUndefined,
    z
      .url()
      .refine((u) => u.includes("sandbox"), "must be a sandbox URL (live PayPal is not allowed)")
      .default("https://api-m.sandbox.paypal.com"),
  ),
  PAYPAL_PARTNER_ATTRIBUTION_ID: optionalString,
  PAYPAL_PARTNER_MERCHANT_ID: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  PAYMENT_RAIL: z.preprocess(
    blankToUndefined,
    z.enum(["delayed_disbursement", "auth_capture"]).default("delayed_disbursement"),
  ),

  DEMO_CLIENT_EMAIL: z.preprocess(blankToUndefined, z.email().optional()),
  DEMO_WORKER_EMAIL: z.preprocess(blankToUndefined, z.email().optional()),
  DEMO_WORKER_MERCHANT_ID: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  LLM_MODEL: optionalString,

  VERIFIER_BROWSER: z.preprocess(blankToUndefined, z.enum(["kernel", "local"]).default("kernel")),
  KERNEL_API_KEY: optionalString,
  QUORUM_N: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(7).default(3)),
  QUORUM_K: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(7).default(2)),
  VERIFIER_KEYS_DIR: z.preprocess(blankToUndefined, z.string().default("./data/keys")),
  /** JSON object {verifier_id: Ed25519 private JWK}. Overrides the keys dir (for hosts without a disk). */
  VERIFIER_KEYS_JSON: optionalString,
  EVIDENCE_DIR: z.preprocess(blankToUndefined, z.string().default("./data/evidence")),
  VERIFIER_CHECK_TIMEOUT_MS: z.preprocess(blankToUndefined, z.coerce.number().int().min(1000).max(120_000).default(20_000)),
  JUDGE_MODELS: z.preprocess(
    blankToUndefined,
    z
      .string()
      .default("claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5")
      .transform((s) => s.split(",").map((m) => m.trim()).filter(Boolean))
      .pipe(z.array(z.string()).min(1)),
  ),

  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().positive().default(3000)),
  PUBLIC_BASE_URL: z.preprocess(blankToUndefined, z.url().default("http://localhost:3000")),
  DATABASE_PATH: z.preprocess(blankToUndefined, z.string().default("./data/kept.db")),
  MCP_AUTH_TOKEN: optionalString,
})
  .superRefine((env, ctx) => {
    // 2k > n means two conflicting quorums can never both form, so a single
    // verifier can neither pay out nor block a payment on its own.
    if (env.QUORUM_K > env.QUORUM_N) {
      ctx.addIssue({ code: "custom", path: ["QUORUM_K"], message: `must be at most QUORUM_N (${env.QUORUM_N})` });
    } else if (2 * env.QUORUM_K <= env.QUORUM_N) {
      ctx.addIssue({
        code: "custom",
        path: ["QUORUM_K"],
        message: `must be more than half of QUORUM_N (${env.QUORUM_N}), so two conflicting quorums cannot both form`,
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env;
  paypal: {
    clientId?: string;
    clientSecret?: string;
    baseUrl: string;
    partnerAttributionId?: string;
    partnerMerchantId?: string;
    webhookId?: string;
    rail: Env["PAYMENT_RAIL"];
  };
  demo: { clientEmail?: string; workerEmail?: string; workerMerchantId?: string };
  llm: { apiKey?: string; model?: string };
  verifier: {
    browser: Env["VERIFIER_BROWSER"];
    kernelApiKey?: string;
    quorumN: number;
    quorumK: number;
    keysDir: string;
    keysJson?: string;
    judgeModels: string[];
    evidenceDir: string;
    checkTimeoutMs: number;
  };
  app: { port: number; publicBaseUrl: string; databasePath: string; mcpAuthToken?: string };
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly keys: string[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => String(i.path[0]));
    const lines = parsed.error.issues.map((i) => `  - ${String(i.path[0])}: ${i.message}`);
    throw new ConfigError(`Invalid environment variables:\n${lines.join("\n")}\nSee .env.example.`, keys);
  }
  const env = parsed.data;
  return {
    env,
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      baseUrl: env.PAYPAL_BASE_URL,
      partnerAttributionId: env.PAYPAL_PARTNER_ATTRIBUTION_ID,
      partnerMerchantId: env.PAYPAL_PARTNER_MERCHANT_ID,
      webhookId: env.PAYPAL_WEBHOOK_ID,
      rail: env.PAYMENT_RAIL,
    },
    demo: {
      clientEmail: env.DEMO_CLIENT_EMAIL,
      workerEmail: env.DEMO_WORKER_EMAIL,
      workerMerchantId: env.DEMO_WORKER_MERCHANT_ID,
    },
    llm: { apiKey: env.ANTHROPIC_API_KEY, model: env.LLM_MODEL },
    verifier: {
      browser: env.VERIFIER_BROWSER,
      kernelApiKey: env.KERNEL_API_KEY,
      quorumN: env.QUORUM_N,
      quorumK: env.QUORUM_K,
      keysDir: env.VERIFIER_KEYS_DIR,
      keysJson: env.VERIFIER_KEYS_JSON,
      judgeModels: env.JUDGE_MODELS,
      evidenceDir: env.EVIDENCE_DIR,
      checkTimeoutMs: env.VERIFIER_CHECK_TIMEOUT_MS,
    },
    app: {
      port: env.PORT,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      databasePath: env.DATABASE_PATH,
      mcpAuthToken: env.MCP_AUTH_TOKEN,
    },
  };
}

/** Keys each service needs before it can be used. */
export function requiredKeys(env: Env): Record<ConfigGroup, (keyof Env)[]> {
  return {
    paypal: [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      ...(env.PAYMENT_RAIL === "delayed_disbursement"
        ? (["PAYPAL_PARTNER_ATTRIBUTION_ID", "PAYPAL_PARTNER_MERCHANT_ID"] as const)
        : []),
    ],
    demo: ["DEMO_CLIENT_EMAIL", "DEMO_WORKER_EMAIL"],
    llm: ["ANTHROPIC_API_KEY", "LLM_MODEL"],
    verifier: env.VERIFIER_BROWSER === "kernel" ? ["KERNEL_API_KEY"] : [],
    mcp: ["MCP_AUTH_TOKEN"],
    webhooks: ["PAYPAL_WEBHOOK_ID"],
  };
}

export type ConfigGroup = "paypal" | "demo" | "llm" | "verifier" | "mcp" | "webhooks";

export function missingKeys(config: Config, group: ConfigGroup): string[] {
  return requiredKeys(config.env)[group].filter((k) => config.env[k] === undefined);
}

/** Throws a ConfigError naming every missing key the given groups need. */
export function requireConfig(config: Config, ...groups: ConfigGroup[]): void {
  const missing = [...new Set(groups.flatMap((g) => missingKeys(config, g)))];
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing environment variables for ${groups.join(", ")}: ${missing.join(", ")}.\n` +
        `Add them to .env (see .env.example), then run \`npm run doctor\`.`,
      missing,
    );
  }
}
