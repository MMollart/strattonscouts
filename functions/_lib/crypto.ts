// Cryptography helpers using the WebCrypto API (available in the Cloudflare
// Workers runtime). No Node-only dependencies.

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PBKDF2_ITERATIONS = 100_000;

/** Hash a password with PBKDF2-SHA256 and a random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

/** Constant-time comparison of two hex strings of equal length. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromHex(parts[2]);
  const expected = parts[3];
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return timingSafeEqualHex(toHex(bits), expected);
}

/** SHA-256 hash (hex) — used for opaque tokens stored in the DB. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return toHex(digest);
}

/** Generate a cryptographically random opaque token (hex). */
export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  // Derive a stable 256-bit AES key from the configured secret.
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

/** Encrypt a plaintext string for storage at rest (AES-GCM). */
export async function encryptAtRest(plaintext: string, secret: string): Promise<string> {
  if (!secret) return plaintext; // dev fallback when no key configured
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(ct))}`;
}

/** Decrypt a value previously produced by encryptAtRest. */
export async function decryptAtRest(stored: string | null, secret: string): Promise<string | null> {
  if (stored == null) return null;
  if (!stored.startsWith('v1:')) return stored; // not encrypted (dev fallback)
  if (!secret) return null;
  const [, ivB64, ctB64] = stored.split(':');
  const key = await deriveAesKey(secret);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(ivB64) },
      key,
      fromBase64(ctB64),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}
