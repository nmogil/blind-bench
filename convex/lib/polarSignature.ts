/**
 * Standard Webhooks signature verification for Polar webhooks.
 * https://www.standardwebhooks.com/ — Polar signs with this scheme.
 *
 * Signed content is `${webhook-id}.${webhook-timestamp}.${rawBody}`. The
 * `webhook-signature` header is a space-delimited list of `v1,<base64sig>`
 * entries (key rotation can send several); the message is authentic if ANY
 * entry matches our HMAC-SHA256 over the signed content.
 *
 * The secret is the Standard Webhooks form `whsec_<base64>`; the HMAC key is
 * the base64-decoded portion after the prefix. A raw (non-prefixed) secret is
 * accepted as UTF-8 bytes so local testing can use a plain string.
 *
 * Pure (Web Crypto only) so it runs under the Convex V8 runtime and the
 * vitest edge-runtime without `_generated`.
 */

const DEFAULT_TOLERANCE_SECONDS = 300; // 5 min replay window

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function secretToKeyBytes(secret: string): Uint8Array {
  if (secret.startsWith("whsec_")) return fromBase64(secret.slice("whsec_".length));
  return new TextEncoder().encode(secret);
}

async function hmacBase64(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toBase64(new Uint8Array(sig));
}

/** Length-independent constant-time string compare. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyArgs {
  id: string;
  timestamp: string; // unix seconds, as sent in `webhook-timestamp`
  signature: string; // raw `webhook-signature` header value
  body: string; // raw request body, exactly as received
  secret: string;
  toleranceSeconds?: number;
  /** Injectable clock for tests. Defaults to Date.now(). */
  nowMs?: number;
}

/**
 * Returns true iff the signature is valid AND the timestamp is within the
 * replay tolerance. Never throws on bad input — returns false.
 */
export async function verifyWebhook(args: VerifyArgs): Promise<boolean> {
  const tolerance = args.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = args.nowMs ?? Date.now();

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > tolerance) return false;

  let expected: string;
  try {
    const signedContent = `${args.id}.${args.timestamp}.${args.body}`;
    expected = await hmacBase64(secretToKeyBytes(args.secret), signedContent);
  } catch {
    return false;
  }

  for (const part of args.signature.split(" ")) {
    const comma = part.indexOf(",");
    if (comma === -1) continue;
    const value = part.slice(comma + 1);
    if (timingSafeEqual(value, expected)) return true;
  }
  return false;
}

/**
 * Produce a valid `webhook-signature` header value for the given content.
 * Used by tests (and any local sender) to exercise verification end-to-end.
 */
export async function signWebhook(
  id: string,
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  const signedContent = `${id}.${timestamp}.${body}`;
  const sig = await hmacBase64(secretToKeyBytes(secret), signedContent);
  return `v1,${sig}`;
}
