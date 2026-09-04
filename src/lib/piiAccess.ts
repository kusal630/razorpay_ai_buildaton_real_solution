import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("piiAccess");

export async function recordPiiAccess(params: {
  actor: string;
  customer_id: string;
  purpose: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO pii_access_log (actor, customer_id, purpose)
       VALUES ($1, $2, $3)`,
      [params.actor, params.customer_id, params.purpose]
    );
    log.debug({ actor: params.actor, purpose: params.purpose }, "PII access logged");
  } catch (err: any) {
    log.error({ error: err.message }, "Failed to log PII access");
  }
}
