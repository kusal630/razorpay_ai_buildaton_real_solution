/**
 * adminAudit.ts — single safe writer for the admin audit trail.
 * Live shape: (id, ts, admin_user TEXT, action, detail JSONB, ip).
 * Never throws (audit must not hang the request — Express 4 leaves
 * async throws unanswered).
 */
import { query } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("adminAudit");

export async function recordAdminAudit(params: {
  adminUser?: string | null;
  action: string;
  detail?: unknown;
  ip?: string | null;
}): Promise<void> {
  try {
    await query(
      "INSERT INTO admin_audit (admin_user, action, detail, ip) VALUES ($1, $2, $3, $4)",
      [
        params.adminUser != null ? String(params.adminUser) : null,
        params.action,
        JSON.stringify(params.detail ?? {}),
        params.ip || null,
      ]
    );
  } catch (err: any) {
    log.warn({ action: params.action, error: err?.message }, "Admin audit write failed (non-blocking)");
  }
}
