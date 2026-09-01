import crypto from "node:crypto";
import { createLogger } from "../logger.js";

const log = createLogger("redact");

// PII patterns to detect and redact
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /\+?[1-9]\d{1,14}/g; // E.164 format
const INDIAN_PHONE_REGEX = /(\+91|91)?[6-9]\d{9}/g;

/**
 * Generate a deterministic fingerprint for PII.
 * Returns first 12 hex chars of SHA-256.
 */
export function fingerprint(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * Redact PII from a string, replacing with sha256[:12] fingerprints.
 */
export function redactString(input: string): string {
  let result = input;

  // Redact emails
  result = result.replace(EMAIL_REGEX, (match) => `fp:${fingerprint(match)}`);

  // Redact Indian phone numbers
  result = result.replace(INDIAN_PHONE_REGEX, (match) => `fp:${fingerprint(match)}`);

  // Redact E.164 phone numbers
  result = result.replace(PHONE_REGEX, (match) => {
    // Skip if it's too short to be a phone number
    if (match.length < 7) return match;
    return `fp:${fingerprint(match)}`;
  });

  return result;
}

/**
 * Deep redact PII from an object, replacing contact/email/name fields.
 * Central redaction function for all persisted payloads (N14).
 */
export function redactForPersist<T>(payload: T): T {
  if (typeof payload === "string") {
    return redactString(payload) as T;
  }

  if (Array.isArray(payload)) {
    return payload.map((item) => redactForPersist(item)) as T;
  }

  if (payload && typeof payload === "object") {
    const result: any = {};
    for (const [key, value] of Object.entries(payload)) {
      // Direct PII field redaction
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("email") ||
        lowerKey.includes("phone") ||
        lowerKey.includes("contact") ||
        lowerKey.includes("name") ||
        lowerKey === "customer"
      ) {
        if (typeof value === "string") {
          result[key] = `fp:${fingerprint(value)}`;
        } else if (typeof value === "object" && value !== null) {
          result[key] = redactForPersist(value);
        } else {
          result[key] = value;
        }
      } else if (typeof value === "object" && value !== null) {
        result[key] = redactForPersist(value);
      } else {
        result[key] = value;
      }
    }
    return result as T;
  }

  return payload;
}

/**
 * Check if a string contains PII (for scanning tables/logs).
 */
export function containsPII(input: string): boolean {
  return (
    EMAIL_REGEX.test(input) ||
    INDIAN_PHONE_REGEX.test(input)
  );
}

/**
 * Scan a string and return any detected PII fingerprints.
 */
export function scanForPII(input: string): string[] {
  const fingerprints: string[] = [];

  const emails = input.match(EMAIL_REGEX);
  if (emails) {
    for (const email of emails) {
      fingerprints.push(fingerprint(email));
    }
  }

  const phones = input.match(INDIAN_PHONE_REGEX);
  if (phones) {
    for (const phone of phones) {
      fingerprints.push(fingerprint(phone));
    }
  }

  return [...new Set(fingerprints)];
}
