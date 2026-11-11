import { z } from "zod";
import { ChecklistFrozenError, ChecklistTamperedError } from "../core/checklist-store.js";
import { ForbiddenError, JobInputError, RailError } from "../core/jobs.js";
import { DecisionError } from "../core/proof-store.js";
import { SettlementError } from "../core/settlement.js";
import { IllegalTransitionError, JobNotFoundError } from "../core/state.js";
import { VerificationError } from "../verifier/orchestrator.js";
import { ChecklistGenerationError } from "../llm/checklist-gen.js";
import { LlmError } from "../llm/client.js";

/** A feature this server is not configured for (no PayPal rail yet, no verifier, no write secret). */
export class ServiceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailable";
  }
}

export interface ClassifiedError {
  status: number;
  error: string;
  code?: string;
  issues?: unknown;
}

/**
 * Maps a domain error to an HTTP status and a message a person (or agent) can
 * act on. Shared by the REST API and the MCP server. Unknown errors → undefined.
 */
export function classifyError(err: unknown): ClassifiedError | undefined {
  if (err instanceof z.ZodError) {
    const issue = err.issues[0];
    return { status: 400, error: `${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`, issues: err.issues };
  }
  if (err instanceof SyntaxError && "body" in err) return { status: 400, error: "body is not valid JSON" };
  if (err instanceof JobInputError) return { status: 400, error: err.message };
  if (err instanceof ForbiddenError) return { status: 403, error: err.message };
  if (err instanceof JobNotFoundError) return { status: 404, error: err.message };
  if (err instanceof IllegalTransitionError || err instanceof ChecklistFrozenError || err instanceof DecisionError || err instanceof VerificationError) {
    return { status: 409, error: err.message };
  }
  if (err instanceof SettlementError) return { status: 409, error: err.message, code: err.code };
  if (err instanceof ChecklistTamperedError) return { status: 500, error: err.message };
  if (err instanceof RailError) return { status: 502, error: err.message };
  if (err instanceof ServiceUnavailable) return { status: 503, error: err.message };
  if (err instanceof ChecklistGenerationError) return { status: 422, error: err.message };
  if (err instanceof LlmError) return { status: 502, error: `Language model: ${err.message}` };
  return undefined;
}
