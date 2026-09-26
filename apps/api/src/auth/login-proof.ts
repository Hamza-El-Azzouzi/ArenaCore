import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { LoginProof } from './oidc.gateway';
const proofSchema = z.strictObject({provider: z.enum(['auth0', 'google', 'github']), verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/)});
export function encryptProof(key: Buffer, stateHash: string, proof: LoginProof): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(stateHash));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(proof), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function decryptProof(key: Buffer, stateHash: string, encoded: string): LoginProof {
  const data = Buffer.from(encoded, 'base64url');
  if (data.length < 29) throw new Error('Invalid encrypted proof');
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(stateHash));
  decipher.setAuthTag(data.subarray(12, 28));
  return proofSchema.parse(JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')));
}
