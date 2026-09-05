/**
 * reconcile.ts — payment-link status comparison (pure, unit-covered).
 *
 * Vocabulary gap (the 32-"critical" false alarm): our ledger stores an
 * unpaid, awaiting-payment link as `live`; Razorpay reports the SAME link
 * as `created` (or `partially_paid`). Those are the same state — awaiting
 * payment — not a divergence. Only a REAL disagreement (e.g. we say paid
 * and Razorpay says created, or vice versa) is critical. An unreachable
 * gateway (fetch threw) proves nothing either way → warn, never critical.
 */

export type LinkStatus = string;

/** Normalize both vocabularies to a canonical settlement state. */
export function canonicalLinkStatus(status: LinkStatus | null | undefined): string {
  const s = String(status || "").toLowerCase();
  if (s === "live" || s === "created" || s === "partially_paid" || s === "authenticated") {
    return "awaiting_payment";
  }
  if (s === "paid" || s === "captured") return "paid";
  if (s === "expired") return "expired";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "refunded") return "refunded";
  if (s === "failed") return "failed";
  return s || "unknown";
}

export interface LinkVerdict {
  matched: boolean;
  severity: "critical" | "warn";
  status_local: string;
  status_remote: string;
}

/**
 * Compare one link. Returns matched=true when both sides agree
 * (after vocabulary normalization). Unreachable remote → warn.
 */
export function classifyLink(
  local: LinkStatus | null | undefined,
  remote: LinkStatus | null | undefined,
  remoteUnreachable: boolean
): LinkVerdict {
  const status_local = String(local || "unknown");
  const status_remote = remoteUnreachable ? "unreachable" : String(remote || "unknown");
  if (remoteUnreachable) {
    return { matched: false, severity: "warn", status_local, status_remote };
  }
  const same = canonicalLinkStatus(local) === canonicalLinkStatus(remote);
  return {
    matched: same,
    severity: same ? "warn" : "critical",
    status_local,
    status_remote,
  };
}
