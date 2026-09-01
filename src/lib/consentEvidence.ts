import crypto from "node:crypto";
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("consentEvidence");

/**
 * C2: Consent evidence types and sources.
 */
export type ConsentSource = "merchant_server" | "self_reported" | "checkout_notice";

export interface ConsentEvidence {
  source: ConsentSource;
  evidence_reference: string; // merchant's reference, checkout notice ID, etc.
  recorded_at: string;
  merchant_id?: string;
}

/**
 * C2: Record consent event with evidence.
 * Can only be called from server-side routes (merchant_server or checkout_notice).
 * Self-reported consent is flagged but not binding without merchant-server verification.
 */
export async function recordConsentEvent(params: {
  customerId: string;
  consentType: "transactional" | "marketing";
  optIn: boolean;
  source: ConsentSource;
  evidenceReference: string;
  merchantId?: string;
}): Promise<void> {
  // C2: Anonymous/public routes cannot set marketing consent
  if (params.source !== "merchant_server" && params.consentType === "marketing") {
    log.warn(
      { customerId: params.customerId, source: params.source },
      "Cannot set marketing consent from non-server source"
    );
    return;
  }

  await query(
    `INSERT INTO consent_events (customer_id, consent_type, opt_in, source, evidence_reference, merchant_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.customerId,
      params.consentType,
      params.optIn,
      params.source,
      params.evidenceReference,
      params.merchantId,
    ]
  );

  // Also update customer's consent record
  if (params.consentType === "marketing") {
    await query(
      `UPDATE customers SET consent_marketing = jsonb_build_object(
        'opt_in', $2,
        'source', $3,
        'evidence_reference', $4,
        'consented_at', NOW()::text
      ) WHERE id = $1`,
      [
        params.customerId,
        params.optIn,
        params.source,
        params.evidenceReference,
      ]
    );
  }

  log.debug(
    { customerId: params.customerId, consentType: params.consentType, source: params.source },
    "Consent event recorded"
  );
}

/**
 * C2: Get consent evidence for a customer.
 */
export async function getConsentEvidence(
  customerId: string,
  consentType?: "transactional" | "marketing"
): Promise<ConsentEvidence[]> {
  let sql = `SELECT source, evidence_reference, recorded_at, merchant_id
             FROM consent_events WHERE customer_id = $1`;
  const params: any[] = [customerId];

  if (consentType) {
    sql += ` AND consent_type = $2`;
    params.push(consentType);
  }

  sql += ` ORDER BY recorded_at DESC`;

  const { rows } = await query(sql, params);

  return rows.map((row) => ({
    source: row.source as ConsentSource,
    evidence_reference: row.evidence_reference,
    recorded_at: row.recorded_at,
    merchant_id: row.merchant_id,
  }));
}
