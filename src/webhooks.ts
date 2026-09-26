import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Kora's webhook signature (developers.korapay.com/docs/webhooks).
 *
 * Two details that are easy to get wrong:
 * - The header is `x-korapay-signature` (lowercase, no "Kora"-branded casing).
 * - The HMAC is computed over ONLY the `data` object of the payload, not the
 *   raw request body and not the full `{ event, data }` envelope. Pass
 *   `payload.data` (or `payload.data` re-stringified) here, not `req.body`.
 */
export function verifyKoraSignature(data: unknown, signature: string, secretKey: string): boolean {
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  const expected = createHmac("sha256", secretKey).update(serialized).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const signatureBuf = Buffer.from(signature, "utf8");

  if (expectedBuf.length !== signatureBuf.length) return false;
  return timingSafeEqual(expectedBuf, signatureBuf);
}
