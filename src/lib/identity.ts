import crypto from "node:crypto";
import { query } from "../db.js";
import { encrypt } from "./crypto.js";
import { createLogger } from "../logger.js";

const log = createLogger("identity");

const IDENTITY_SECRET = process.env.IDENTITY_SECRET || "sellable-identity-secret-v1";

/**
 * W5: Normalize contact for identity token.
 * Email: lowercase + trim. Phone: E.164 normalize (remove spaces, dashes, parentheses).
 * Phone takes precedence as identity key when present.
 */
export function normalizeContact(contact: {
  email?: string;
  phone?: string;
}): { normalized: string; type: "phone" | "email" } {
  if (contact.phone) {
    // E.164 normalize: remove all non-digit chars, ensure starts with country code
    let phone = contact.phone.replace(/[\s\-\(\)]/g, "");
    if (phone.startsWith("0")) {
      phone = "+91" + phone.slice(1); // Assume India for leading 0
    } else if (!phone.startsWith("+")) {
      phone = "+" + phone;
    }
    return { normalized: phone, type: "phone" };
  }

  if (contact.email) {
    return { normalized: contact.email.toLowerCase().trim(), type: "email" };
  }

  throw new Error("Either email or phone must be provided");
}

/**
 * W5: Generate identity token using HMAC-SHA256.
 * identity_token = HMAC(secret, normalize(contact))
 * Stored in customers.identity_hash on the remote schema.
 */
export function generateIdentityToken(contact: {
  email?: string;
  phone?: string;
}): string {
  const { normalized } = normalizeContact(contact);
  return crypto.createHmac("sha256", IDENTITY_SECRET).update(normalized).digest("hex");
}

/**
 * W5: Find or create customer by identity hash.
 * Remote shape: (id, merchant_id, identity_hash, contact_enc, segment, ...).
 * Returns { customerId, isNew, identityToken }.
 */
export async function findOrCreateCustomer(
  merchantId: string,
  contact: {
    email?: string;
    phone?: string;
    name?: string;
    segment?: string;
  }
): Promise<{ customerId: string; isNew: boolean; identityToken: string }> {
  const identityToken = generateIdentityToken(contact);

  // Check existing by identity hash
  const { rows: existing } = await query(
    "SELECT id FROM customers WHERE merchant_id = $1 AND identity_hash = $2",
    [merchantId, identityToken]
  );

  if (existing[0]) {
    return { customerId: existing[0].id, isNew: false, identityToken };
  }

  // Create new customer (contact stored encrypted at rest)
  const raw = contact.phone || contact.email || "";
  let contactEnc = raw;
  try {
    contactEnc = raw ? encrypt(raw) : "";
  } catch {
    contactEnc = raw;
  }
  const { rows } = await query(
    `INSERT INTO customers (merchant_id, identity_hash, contact_enc, segment)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [merchantId, identityToken, contactEnc, contact.segment || "default"]
  );

  log.debug({ customerId: rows[0].id }, "New customer created");
  return { customerId: rows[0].id, isNew: true, identityToken };
}

/**
 * W5: Get customer by identity token.
 */
export async function getCustomerByIdentity(
  merchantId: string,
  identityToken: string
): Promise<{ id: string } | null> {
  const { rows } = await query(
    "SELECT id FROM customers WHERE merchant_id = $1 AND identity_hash = $2",
    [merchantId, identityToken]
  );
  return rows[0] || null;
}
