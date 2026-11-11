import type { PaymentRail } from "./types.js";

/**
 * A stand-in for PayPal that moves no money, for previews and offline demos
 * until the PayPal sandbox is connected. Every ID it returns starts with
 * OFFLINE- so nobody can mistake it for a real payment, and the demo says so
 * out loud. The real server never uses it.
 */
export function offlineRail(): PaymentRail & { offline: true } {
  return {
    offline: true,
    name: "auth_capture",
    lock: async (job) => ({ orderId: `OFFLINE-ORDER-${job.id}`, approveUrl: "about:blank#offline-no-paypal-approval-needed" }),
    confirmLocked: async (job) => ({ captureIds: [`OFFLINE-CAPTURE-${job.id}`] }),
    releaseMilestone: async (job, ms) => ({ paypalId: `OFFLINE-RELEASE-${job.id}-${ms.position + 1}` }),
    refundMilestone: async (job, ms) => ({ paypalId: `OFFLINE-REFUND-${job.id}-${ms.position + 1}` }),
    status: async () => ({ orderStatus: "OFFLINE", heldCents: 0, releasedCents: 0, refundedCents: 0 }),
  };
}

export const isOfflineRail = (rail: PaymentRail | undefined): boolean => !!rail && "offline" in rail;
