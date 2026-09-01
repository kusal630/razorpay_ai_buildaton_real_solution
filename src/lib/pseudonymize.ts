import crypto from "node:crypto";

export function pseudonymize(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
}
