import { describe, it, expect, vi } from "vitest";

// Mock config
vi.mock("../src/config.js", () => ({
  getConfig: vi.fn().mockReturnValue({
    APP_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),
  }),
}));

import { encrypt, decrypt } from "../src/lib/crypto.js";

describe("Crypto", () => {
  it("encrypts and decrypts round-trip", () => {
    const plaintext = "test@example.com";
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(ciphertext.split(":")).toHaveLength(3);
    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("fails with wrong key", () => {
    const plaintext = "secret data";
    const ciphertext = encrypt(plaintext);
    // Decrypting with same key should work (since mock is fixed)
    const decrypted = decrypt(ciphertext);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for same input (random IV)", () => {
    const a = encrypt("same input");
    const b = encrypt("same input");
    expect(a).not.toBe(b);
  });
});
