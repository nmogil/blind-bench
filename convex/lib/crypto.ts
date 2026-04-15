/**
 * AES-GCM encrypt/decrypt for BYOK key storage.
 * Uses Web Crypto API (available in Convex V8 runtime).
 */

// Cryptographic constant for key derivation — must NOT be changed or all
// existing encrypted BYOK keys become undecryptable. Old name is intentional.
const SALT = new TextEncoder().encode("hot-or-prompt-v1");
const IV_LENGTH = 12;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  // Hash the secret with SHA-256 to get a 256-bit AES key.
  // HKDF is not available in Convex's V8 runtime.
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret + toBase64(SALT)),
  );
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encrypt(plaintext: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return toBase64(combined);
}

/** Generate a URL-safe random token that cannot contain Convex IDs as substrings. */
export function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Convert to hex — contains only [0-9a-f], safe from Convex ID substrings
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function decrypt(encrypted: string, secret: string): Promise<string> {
  const combined = fromBase64(encrypted);
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const key = await deriveKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}
