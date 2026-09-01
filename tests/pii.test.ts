import { describe, it, expect, vi } from "vitest";

// Mock config before importing crypto
vi.mock("../src/config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
    APP_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  }),
}));

import { pseudonymize } from "../src/lib/pseudonymize.js";
import { encrypt, decrypt } from "../src/lib/crypto.js";

describe("PII Protection", () => {
  it("pseudonymize produces consistent short hash", () => {
    const id = "customer-123-uuid";
    const p = pseudonymize(id);
    expect(p).toHaveLength(12);
    expect(p).toBe(pseudonymize(id));
  });

  it("PII encrypted at rest", () => {
    const email = "user@example.com";
    const encrypted = encrypt(email);
    expect(encrypted).not.toContain("user@example.com");
    expect(encrypted).not.toContain("@");
  });

  it("decrypt reverses encrypt", () => {
    const plaintext = "9999999999";
    const ciphertext = encrypt(plaintext);
    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("pseudonymized IDs are safe for LLM", () => {
    const realId = "user@example.com";
    const pseudo = pseudonymize(realId);
    expect(pseudo).not.toContain("@");
    expect(pseudo).not.toContain("user");
  });
});
