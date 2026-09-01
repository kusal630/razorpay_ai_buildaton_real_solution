import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("budget");

/**
 * Reserve budget for an action.
 * Atomic conditional UPDATE: "SET reserved = reserved + X WHERE day = today AND reserved + X <= cap"
 * Returns true if reserved, false if budget_exhausted.
 */
export async function reserveBudget(
  merchantId: string,
  amountPaise: number
): Promise<{ reserved: boolean; reason?: string }> {
  const today = new Date().toISOString().slice(0, 10);

  // Ensure today's budget row exists
  await query(
    `INSERT INTO daily_budget (day, merchant_id, cap_paise)
     VALUES ($1, $2, 500000)
     ON CONFLICT (day, merchant_id) DO NOTHING`,
    [today, merchantId]
  );

  // Atomic conditional reserve
  const { rowCount } = await query(
    `UPDATE daily_budget
     SET reserved_paise = reserved_paise + $1
     WHERE day = $2
       AND merchant_id = $3
       AND reserved_paise + $1 <= cap_paise`,
    [amountPaise, today, merchantId]
  );

  if (rowCount === 0) {
    log.warn({ merchantId, amountPaise }, "Budget exhausted");
    return { reserved: false, reason: "budget_exhausted" };
  }

  log.debug({ merchantId, amountPaise }, "Budget reserved");
  return { reserved: true };
}

/**
 * Release reserved budget (on skip, fail, or expiry).
 */
export async function releaseBudget(
  merchantId: string,
  amountPaise: number
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  await query(
    `UPDATE daily_budget
     SET reserved_paise = GREATEST(reserved_paise - $1, 0)
     WHERE day = $2 AND merchant_id = $3`,
    [amountPaise, today, merchantId]
  );

  log.debug({ merchantId, amountPaise }, "Budget released");
}

/**
 * Realize reserved budget (on success).
 */
export async function realizeBudget(
  merchantId: string,
  amountPaise: number
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  await query(
    `UPDATE daily_budget
     SET reserved_paise = GREATEST(reserved_paise - $1, 0),
         realized_paise = realized_paise + $1
     WHERE day = $2 AND merchant_id = $3`,
    [amountPaise, today, merchantId]
  );

  log.debug({ merchantId, amountPaise }, "Budget realized");
}

/**
 * Get current budget status for a merchant.
 */
export async function getBudgetStatus(
  merchantId: string
): Promise<{
  capPaise: number;
  reservedPaise: number;
  realizedPaise: number;
  availablePaise: number;
}> {
  const today = new Date().toISOString().slice(0, 10);

  const { rows } = await query(
    "SELECT cap_paise, reserved_paise, realized_paise FROM daily_budget WHERE day = $1 AND merchant_id = $2",
    [today, merchantId]
  );

  if (!rows[0]) {
    return { capPaise: 500000, reservedPaise: 0, realizedPaise: 0, availablePaise: 500000 };
  }

  const row = rows[0];
  return {
    capPaise: Number(row.cap_paise),
    reservedPaise: Number(row.reserved_paise),
    realizedPaise: Number(row.realized_paise),
    availablePaise: Number(row.cap_paise) - Number(row.reserved_paise),
  };
}
