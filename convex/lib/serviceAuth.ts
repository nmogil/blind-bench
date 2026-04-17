/**
 * Service token authentication for the public /api/v1/* HTTP surface.
 *
 * Token wire format: bbst_<env>_<48-hex-chars>
 *   - env ∈ "live" | "test" — informational, not enforced server-side
 *   - 48 hex chars = 24 random bytes (192 bits)
 *
 * Storage: only SHA-256(plaintext) is persisted in the serviceTokens table.
 * The plaintext is shown to the user exactly once at mint time.
 *
 * This module is the source of truth for parsing, hashing, and scope checks.
 * HTTP routes call ctx.runMutation(internal.serviceTokens.validateAndStamp)
 * which uses these helpers. Do not duplicate the wire format anywhere else.
 */

import { Doc } from "../_generated/dataModel";

export type Scope =
  | "runs:read"
  | "runs:write"
  | "cycles:read"
  | "cycles:write"
  | "evaluator:read"
  | "evaluator:write";

export const TOKEN_PREFIX = "bbst_";
const TOKEN_BODY_BYTES = 24;
const TOKEN_HEX_LEN = TOKEN_BODY_BYTES * 2;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a fresh plaintext service token. Returned to the user once. */
export function mintToken(env: "live" | "test" = "live"): string {
  const bytes = new Uint8Array(TOKEN_BODY_BYTES);
  crypto.getRandomValues(bytes);
  return `${TOKEN_PREFIX}${env}_${toHex(bytes)}`;
}

/** SHA-256 hex of the plaintext token. Storage and lookup key. */
export async function hashToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext),
  );
  return toHex(new Uint8Array(digest));
}

/**
 * Display prefix shown in the UI: "bbst_<env>_<first8>". Lets users identify
 * which token is which without revealing the secret half.
 */
export function tokenPrefix(plaintext: string): string {
  // bbst_live_abcdef0123… → bbst_live_abcdef01
  const match = plaintext.match(/^(bbst_(live|test)_)([a-f0-9]+)$/);
  if (!match) return plaintext.slice(0, 16);
  return `${match[1]}${match[3]!.slice(0, 8)}`;
}

/** Pull the Bearer token from an Authorization header. Null if missing/malformed. */
export function parseBearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const token = m[1]!;
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  // Reject obviously malformed tokens before hashing.
  const body = token.slice(TOKEN_PREFIX.length).match(/^(live|test)_([a-f0-9]+)$/);
  if (!body || body[2]!.length !== TOKEN_HEX_LEN) return null;
  return token;
}

/** True iff the token grants every scope in `required`. */
export function hasScopes(
  token: Pick<Doc<"serviceTokens">, "scopes">,
  required: Scope[],
): boolean {
  return required.every((s) => token.scopes.includes(s));
}

export function requireScopes(
  token: Pick<Doc<"serviceTokens">, "scopes">,
  required: Scope[],
): void {
  if (!hasScopes(token, required)) {
    throw new Error(
      `Token missing required scope(s): ${required.filter((s) => !token.scopes.includes(s)).join(", ")}`,
    );
  }
}
