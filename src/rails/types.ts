/**
 * All money movement goes through this interface (section 6.5), so the two
 * PayPal rails are interchangeable and settlement logic is testable.
 */

export type RailName = "delayed_disbursement" | "auth_capture";

export interface RailMilestone {
  id: string;
  position: number;
  title: string;
  amountCents: number;
  paypalCaptureId: string | null;
}

export interface RailJob {
  id: string;
  currency: string;
  totalCents: number;
  /** Fingerprint of the agreed contract; sent to PayPal as custom_id. */
  contractHash: string;
  paypalOrderId: string | null;
  workerMerchantId: string | null;
  milestones: RailMilestone[];
}

/** Context for one money-moving call. */
export interface MoneyContext {
  /** Deterministic PayPal-Request-Id, so a retried call can never pay twice. */
  requestId: string;
  /** Hash of the quorum certificate that justified this movement; written onto the PayPal record where the API allows. */
  certificateHash: string;
}

export interface LockResult {
  orderId: string;
  approveUrl: string;
}

export interface MoneyResult {
  /** PayPal ID of the capture, payout item, refund or void; null when nothing had to move (e.g. an uncaptured hold). */
  paypalId: string | null;
}

export interface RailStatus {
  orderStatus: string;
  /** Amounts PayPal reports, in cents. */
  heldCents: number;
  releasedCents: number;
  refundedCents: number;
  raw?: unknown;
}

export interface PaymentRail {
  readonly name: RailName;
  /** Create the PayPal order (custom_id = contract hash) and return the approval link. */
  lock(job: RailJob, ctx: { requestId: string }): Promise<LockResult>;
  /** After the client approves: capture (delayed_disbursement) or authorize (auth_capture). */
  confirmLocked(job: RailJob, ctx: { requestId: string }): Promise<{ captureIds: string[]; authorizationId?: string }>;
  /** Pay one passed milestone to the worker. */
  releaseMilestone(job: RailJob, milestone: RailMilestone, ctx: MoneyContext): Promise<MoneyResult>;
  /** Return one failed milestone to the client. */
  refundMilestone(job: RailJob, milestone: RailMilestone, ctx: MoneyContext): Promise<MoneyResult>;
  /** Called once after every milestone is settled (auth_capture voids what is left of the hold). */
  finalize?(job: RailJob, ctx: MoneyContext): Promise<MoneyResult>;
  /** Read the truth back from PayPal. */
  status(job: RailJob): Promise<RailStatus>;
}
