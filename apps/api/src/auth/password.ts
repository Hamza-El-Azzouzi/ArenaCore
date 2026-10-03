import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
const N = 32768, R = 8, P = 1, LENGTH = 32, MAXMEM = 64 * 1024 * 1024;
const dummy = `scrypt$${N}$${R}$${P}$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(LENGTH).toString('base64url')}`;
function derive(password: string, salt: Buffer, n = N, r = R, p = P) {
  return new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, LENGTH, {N: n, r, p, maxmem: MAXMEM}, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await derive(password, salt);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded?: string) {
  const parts = (encoded ?? dummy).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4]!, 'base64url'), expected = Buffer.from(parts[5]!, 'base64url');
  if (n !== N || r !== R || p !== P || salt.length !== 16 || expected.length !== LENGTH) return false;
  const actual = await derive(password, salt, n, r, p);
  const matches = timingSafeEqual(actual, expected);
  return Boolean(encoded) && matches;
}
