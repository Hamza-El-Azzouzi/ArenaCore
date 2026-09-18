import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { encryptProof, decryptProof } from '../apps/api/src/auth/login-proof';
import { RequireRoles, RolesGuard } from '../apps/api/src/auth/roles.guard';
import { parseConfig } from '../apps/api/src/config/config';
const token = () => randomBytes(32).toString('base64url');

describe('OIDC configuration and login proof encryption', () => {
  const base = {DATABASE_URL: 'postgresql://localhost/identity-test'};
  it('requires every OIDC setting when enabled and keeps omitted OIDC disabled', () => {
    expect(() => parseConfig({...base, OIDC_ENABLED: 'true'})).toThrow();
    expect(parseConfig(base).OIDC_ENABLED).toBe('false');
  });
  it('rejects insecure issuers and unsafe proxy trust settings', () => {
    expect(() => parseConfig({...base, OIDC_ISSUER: 'http://identity.example'})).toThrow();
    expect(() => parseConfig({...base, OIDC_ISSUER: 'https://user:password@identity.example'})).toThrow();
    for (const value of ['true', '1', '0.0.0.0/33', '0.0.0.0/0', '::/0', 'loopback', '127.0.0.1/']) expect(() => parseConfig({...base, TRUST_PROXY_CIDRS: value})).toThrow();
    expect(parseConfig({...base, TRUST_PROXY_CIDRS: '127.0.0.1/32,::1/128'}).TRUST_PROXY_CIDRS).toBe('127.0.0.1/32,::1/128');
  });
  it('rejects invalid or noncanonical encryption keys without echoing secrets', () => {
    expect(() => parseConfig({...base, OIDC_TRANSACTION_KEY: 'PRIVATE_INVALID_KEY'})).toThrow('Invalid configuration: OIDC_TRANSACTION_KEY');
  });
  it('redacts malformed URL configuration values', () => {
    for (const key of ['OIDC_ISSUER', 'PUBLIC_ORIGIN']) {
      try { parseConfig({...base, [key]: 'PRIVATE_INVALID_URL'}); throw new Error('Should fail'); }
      catch (error) { expect((error as Error).message).toContain('Invalid configuration'); expect((error as Error).message).not.toContain('PRIVATE_INVALID_URL'); }
    }
  });
  it('encrypts with random IVs and authenticates ciphertext, key and state binding', () => {
    const key = randomBytes(32), state = 'a'.repeat(64), proof = {verifier: token(), nonce: token()};
    const first = encryptProof(key, state, proof), second = encryptProof(key, state, proof);
    expect(first).not.toBe(second);
    expect(first).not.toContain(proof.verifier);
    expect(decryptProof(key, state, first)).toEqual(proof);
    expect(() => decryptProof(key, 'b'.repeat(64), first)).toThrow();
    expect(() => decryptProof(randomBytes(32), state, first)).toThrow();
    const corrupt = Buffer.from(first, 'base64url'); corrupt[corrupt.length-1] = corrupt[corrupt.length-1]! ^ 1;
    expect(() => decryptProof(key, state, corrupt.toString('base64url'))).toThrow();
  });
});
describe('database-owned RBAC', () => {
  class Handler { @RequireRoles('ADMIN') action() {} }
  const context = (role?: 'USER'|'ADMIN') => ({getHandler: () => Handler.prototype.action, getClass: () => Handler, switchToHttp: () => ({getRequest: () => ({principal: role ? {role} : undefined})})}) as unknown as ExecutionContext;
  it('requires authentication and the declared role', () => {
    const guard = new RolesGuard(new Reflector());
    expect(() => guard.canActivate(context())).toThrow();
    expect(() => guard.canActivate(context('USER'))).toThrow();
    expect(guard.canActivate(context('ADMIN'))).toBe(true);
  });
});
