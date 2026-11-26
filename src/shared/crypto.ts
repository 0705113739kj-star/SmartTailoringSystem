import { hmac } from '@noble/hashes/hmac.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const DEFAULT_LOCAL_SESSION_SECRET = 'smarttailoringsystem-local-desktop-session-key';

let runtimeSessionSecretOverride = '';

export function setRuntimeSessionSecret(secret: string): void {
  runtimeSessionSecretOverride = secret || '';
}

export function getRuntimeSessionSecret(): string {
  if (runtimeSessionSecretOverride) return runtimeSessionSecretOverride;
  if (typeof process !== 'undefined' && process.env?.SESSION_SECRET) {
    return process.env.SESSION_SECRET;
  }
  return DEFAULT_LOCAL_SESSION_SECRET;
}

export function hashPasswordPortable(password: string): string {
  const salt = bytesToHex(randomBytes(16));
  const derived = scrypt(utf8ToBytes(password), utf8ToBytes(salt), {
    N: 16384,
    r: 8,
    p: 1,
    dkLen: 64,
  });
  return `${salt}:${bytesToHex(derived)}`;
}

export function verifyPasswordPortable(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  if (!/^[0-9a-fA-F]+$/.test(expectedHex) || expectedHex.length % 2 !== 0) {
    return false;
  }
  const derived = scrypt(utf8ToBytes(password), utf8ToBytes(salt), {
    N: 16384,
    r: 8,
    p: 1,
    dkLen: 64,
  });
  const expected = hexToBytes(expectedHex);
  if (derived.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < derived.length; i += 1) {
    diff |= derived[i] ^ expected[i];
  }
  return diff === 0;
}

export function hashTokenPortable(token: string, secret = getRuntimeSessionSecret()): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(token)));
}

export function generateOpaqueTokenPortable(): string {
  return bytesToHex(randomBytes(32));
}
