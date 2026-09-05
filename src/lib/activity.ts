import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("activity");

export interface ActivityRow {
  merchant_id: string;
  actor: string;
  type: string;
  summary: string;
  amount_paise?: number;
  data: Record<string, unknown>;
  simulated?: boolean;
  severity?: string;
  /** Feed source tag. Explicit wins; else inferred from linked cart; else 'system'. */
  source_tag?: string;
}

const sseListeners = new Set<any>();

export const SOURCE_TAGS = ["demo", "live", "demo-bg", "system"] as const;
export type SourceTag = (typeof SOURCE_TAGS)[number];

/** Pure: pull a cart id out of an activity data payload, if present. */
export function extractCartId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  for (const k of ["cart_id", "cartId", "cartID", "cart_or_order_ref"]) {
    const v = d[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Pure: resolve the effective tag (allowlisted; garbage → 'system'). */
export function resolveSourceTag(explicit: unknown, cartTag: unknown): SourceTag {
  for (const candidate of [explicit, cartTag]) {
    if (typeof candidate === "string" && (SOURCE_TAGS as readonly string[]).includes(candidate)) {
      return candidate as SourceTag;
    }
  }
  return "system";
}

// PK-lookup cache for cart → source_tag (tags are write-once in practice).
const cartTagCache = new Map<string, string | null>();

async function lookupCartTag(cartId: string): Promise<string | null> {
  const hit = cartTagCache.get(cartId);
  if (hit !== undefined) return hit;
  try {
    const { rows } = await query("SELECT source_tag FROM carts WHERE id = $1", [cartId]);
    const tag = typeof rows[0]?.source_tag === "string" ? rows[0].source_tag : null;
    if (cartTagCache.size > 5000) cartTagCache.clear();
    cartTagCache.set(cartId, tag);
    return tag;
  } catch {
    return null;
  }
}

export async function appendActivity(row: ActivityRow): Promise<number> {
  let tag: SourceTag = resolveSourceTag(row.source_tag, null);
  if (!row.source_tag) {
    const cartId = extractCartId(row.data);
    if (cartId) tag = resolveSourceTag(null, await lookupCartTag(cartId));
  }
  const { rows } = await query(
    `INSERT INTO activity (merchant_id, actor, type, summary, amount_paise, data, simulated, severity, source_tag)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      row.merchant_id, row.actor, row.type, row.summary,
      row.amount_paise != null ? row.amount_paise : null,
      JSON.stringify(row.data), row.simulated || false, row.severity || "info", tag,
    ]
  );

  const full: Record<string, unknown> = {
    id: rows[0].id,
    ts: new Date().toISOString(),
    ...row,
    source_tag: tag,
  };

  broadcast(full);
  return rows[0].id;
}

function broadcast(payload: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseListeners) {
    try { res.write(data); } catch { sseListeners.delete(res); }
  }
}

/**
 * Push a DB row (e.g. written by a raw-SQL path inside a transaction) to
 * live SSE subscribers. Call POST-commit only — never inside the txn.
 * Rows written this way must include source_tag (else 'system').
 */
export function broadcastActivity(row: Record<string, unknown>): void {
  broadcast({ ts: new Date().toISOString(), source_tag: "system", ...row });
}

export function subscribeActivityFeed(res: any): () => void {
  sseListeners.add(res);

  query("SELECT * FROM activity ORDER BY id DESC LIMIT 200")
    .then(({ rows }) => {
      for (const r of rows.reverse()) {
        try { res.write(`data: ${JSON.stringify(r)}\n\n`); } catch { break; }
      }
    })
    .catch(() => {});

  return () => { sseListeners.delete(res); };
}

export async function getRecentActivity(limit = 200, simulated?: boolean): Promise<any[]> {
  const { rows } = simulated == null
    ? await query("SELECT * FROM activity ORDER BY id DESC LIMIT $1", [limit])
    : await query("SELECT * FROM activity WHERE simulated = $1 ORDER BY id DESC LIMIT $2", [simulated, limit]);
  return rows;
}