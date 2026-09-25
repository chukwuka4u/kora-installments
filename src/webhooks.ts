import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the X-Kora-Signature header against the raw request body.
 * Confirm the exact hashing scheme (HMAC-SHA256 over the raw JSON body is the
 * common convention) against Kora's webhook docs before trusting this in production.
 */
export function verifyKoraSignature(rawBody: string, signature: string, secretKey: string): boolean {
  const expected = createHmac("sha256", secretKey).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}
