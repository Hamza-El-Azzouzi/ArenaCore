import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as oidc from 'openid-client';
import { createHmac, randomBytes } from 'node:crypto';
import { AppModule } from '../apps/api/src/app.module';
import { configureApp } from '../apps/api/src/bootstrap';
import { Config } from '../apps/api/src/config/config';
import { OidcGateway } from '../apps/api/src/auth/oidc.gateway';
import { hashToken } from '../apps/api/src/auth/session';
import { OidcProviderFixture, TokenScenario } from './fixtures/oidc-provider';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
class FixtureGateway extends OidcGateway {
  constructor(config: Config, private readonly fixture: OidcProviderFixture) { super(config); }
  protected override discoveryOptions(): oidc.DiscoveryRequestOptions { return {...super.discoveryOptions(), [oidc.customFetch]: this.fixture.fetch}; }
}
interface Start { authorization: URL; cookie: string; state: string }
interface Me {user: {id: string; displayName: string} | null; csrfToken?: string}
async function body<T>(response: Response): Promise<T> { return await response.json() as T; }

integration('OIDC protocol and session integration', () => {
  let app: NestExpressApplication, config: Config, db: PrismaClient, provider: OidcProviderFixture, base: string;
  const stateHashes = new Set<string>();
  const rateKeys = new Set<string>();
  const origin = 'http://localhost:3000';
  const nativeEmail = 'native-auth-test@arenacore.invalid';
  let sessionCookie: string;
  function request(path: string, options: RequestInit = {}) {
    return fetch(`${base}${path}`, {...options, redirect: 'manual'});
  }
  function currentRateKeys() {
    const window = Math.floor(Date.now()/60000);
    const key = Buffer.from(config.values.OIDC_TRANSACTION_KEY!, 'base64');
    const keys = ['global', 'ip:127.0.0.1'].map(scope => createHmac('sha256', key).update(`auth:${window}:${scope}`).digest('hex'));
    keys.forEach(k=>rateKeys.add(k));
    return keys;
  }
  async function start(cookie?: string): Promise<Start> {
    currentRateKeys();
    const response = await request('/auth/login', {headers: cookie ? {cookie} : {}});
    expect(response.status).toBe(302);
    const authorization = new URL(response.headers.get('location')!);
    const state = authorization.searchParams.get('state')!;
    stateHashes.add(hashToken(state));
    return {authorization, state, cookie: response.headers.getSetCookie()[0]!.split(';')[0]!};
  }
  function callback(start: Start, scenario: TokenScenario = 'valid', extraCookie = '') {
    const code = provider.issueCode(start.authorization, scenario);
    return request(`/auth/callback?${new URLSearchParams({state: start.state, code, iss: provider.issuer})}`, {headers: {cookie: `${start.cookie}${extraCookie ? `; ${extraCookie}` : ''}`}});
  }
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.PUBLIC_ORIGIN = origin;
    process.env.EXECUTIONS_ENABLED = 'false';
    provider = new OidcProviderFixture();
    await provider.initialize();
    Object.assign(process.env, {OIDC_ENABLED: 'true', PASSWORD_AUTH_ENABLED: 'true', OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: provider.clientId, OIDC_CLIENT_SECRET: provider.secret, OIDC_TRANSACTION_KEY: randomBytes(32).toString('base64'), OIDC_CLIENT_AUTH_METHOD: 'client_secret_basic', OIDC_ID_TOKEN_ALG: 'RS256', AUTH_LOGIN_REQUESTS_PER_MINUTE: '100', AUTH_LOGIN_GLOBAL_PER_MINUTE: '500', TRUST_PROXY_CIDRS: ''});
    config = new Config();
    db = new PrismaClient({datasources: {db: {url: process.env.TEST_DATABASE_URL}}});
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(Config).useValue(config)
      .overrideProvider(OidcGateway).useValue(new FixtureGateway(config, provider)).compile();
    app = configureApp(module.createNestApplication<NestExpressApplication>({bodyParser: false, logger: false}));
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`;
  });
  afterAll(async () => {
    await app?.close();
    if (db) {
      if (provider) {
        const users = await db.user.findMany({where: {OR: [{issuer: provider.issuer, subject: provider.subject}, {issuer: 'arenacore:password', subject: nativeEmail}]}, select: {id: true}});
        await db.auditEvent.deleteMany({where: {actorId: {in: users.map(u=>u.id)}}});
        await db.user.deleteMany({where: {id: {in: users.map(u=>u.id)}}});
      }
      await db.authAttempt.deleteMany({where: {stateHash: {in: [...stateHashes]}}});
      await db.authRateLimit.deleteMany({where: {key: {in: [...rateKeys]}}});
      await db.$disconnect();
    }
    // Test files may share a worker; leave identity disabled for unrelated suites.
    process.env.OIDC_ENABLED = 'false';
    process.env.PASSWORD_AUTH_ENABLED = 'false';
    process.env.GOOGLE_AUTH_ENABLED = 'false';
    process.env.GITHUB_AUTH_ENABLED = 'false';
  });
  it('keeps identity disabled until configured and rejects external return targets', async () => {
    config.values.OIDC_ENABLED = 'false';
    expect((await request('/auth/login')).status).toBe(503);
    config.values.OIDC_ENABLED = 'true';
    expect((await request('/auth/login?returnTo=https://attacker.example')).status).toBe(400);
    expect((await request('/auth/login', {headers: {origin: 'https://attacker.example'}})).status).toBe(403);
    expect((await request('/auth/login', {headers: {'sec-fetch-site': 'cross-site'}})).status).toBe(403);
  });
  it('registers and signs in locally without exposing or storing a plaintext password', async () => {
    currentRateKeys();
    const password = 'correct horse battery staple';
    expect((await request('/auth/register', {method: 'POST', headers: {'content-type': 'application/json', origin}, body: JSON.stringify({displayName: 'Native User', email: nativeEmail.toUpperCase(), password})})).status).toBe(201);
    const duplicate = await request('/auth/register', {method: 'POST', headers: {'content-type': 'application/json', origin}, body: JSON.stringify({displayName: 'Duplicate', email: nativeEmail, password})});
    expect(duplicate.status).toBe(409);
    const credential = await db.credential.findUniqueOrThrow({where: {email: nativeEmail}, include: {user: true}});
    expect(credential.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(credential.passwordHash).not.toContain(password);
    expect(credential.user.displayName).toBe('Native User');
    const wrong = await request('/auth/password', {method: 'POST', headers: {'content-type': 'application/json', origin}, body: JSON.stringify({email: nativeEmail, password: 'this password is incorrect'})});
    expect(wrong.status).toBe(401);
    expect((await body<{error:{code:string}}>(wrong)).error.code).toBe('INVALID_CREDENTIALS');
    expect((await request('/auth/password', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({email: nativeEmail, password})})).status).toBe(403);
    expect((await request('/auth/password', {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://attacker.example'}, body: JSON.stringify({email: nativeEmail, password})})).status).toBe(403);
    const signedIn = await request('/auth/password', {method: 'POST', headers: {'content-type': 'application/json', origin}, body: JSON.stringify({email: nativeEmail, password})});
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.getSetCookie()[0]!.split(';')[0]!;
    const me = await body<Me>(await request('/me', {headers: {cookie}}));
    expect(me.user?.displayName).toBe('Native User');
  });
  it('creates an encrypted expiring proof and a browser-bound PKCE redirect', async () => {
    const flow = await start();
    expect(flow.authorization.origin).toBe(provider.issuer);
    expect(flow.authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.authorization.searchParams.get('response_type')).toBe('code');
    expect(flow.authorization.searchParams.get('redirect_uri')).toBe(`${origin}/api/v1/auth/callback`);
    expect(flow.authorization.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.authorization.searchParams.get('nonce')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await db.authAttempt.findUniqueOrThrow({where: {stateHash: hashToken(flow.state)}});
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(300000);
    expect(row.encryptedPayload).not.toContain(flow.authorization.searchParams.get('nonce')!);
    expect(row.browserTokenHash).toBe(hashToken(flow.cookie.split('=')[1]!));
  });
  it('issues a hashed session, ignores provider ADMIN claims and keeps tokens out of responses', async () => {
    const response = await callback(await start());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${origin}/problems`);
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain('HttpOnly'); expect(cookies[0]).toContain('SameSite=Lax'); expect(cookies[0]).toContain('Path=/');
    expect(cookies[1]).toContain('Max-Age=0');
    expect(cookies.join(' ')).not.toContain('PRIVATE_ACCESS_TOKEN');
    sessionCookie = cookies[0]!.split(';')[0]!;
    const me = await body<Me>(await request('/me', {headers: {cookie: sessionCookie}}));
    expect(me.user?.displayName).toBe('Fixture User'); expect(me.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const user = await db.user.findUniqueOrThrow({where: {id: me.user!.id}});
    expect(user.role).toBe('USER');
    const session = await db.session.findUniqueOrThrow({where: {tokenHash: hashToken(sessionCookie.split('=')[1]!)}});
    expect(session.tokenHash).not.toBe(sessionCookie.split('=')[1]);
    expect(await db.auditEvent.count({where: {actorId: user.id, action: 'AUTH_LOGIN'}})).toBe(1);
  });
  it('rejects missing or wrong browser binding without consuming the legitimate attempt', async () => {
    const flow = await start(), code = provider.issueCode(flow.authorization);
    const path = `/auth/callback?${new URLSearchParams({state: flow.state, code})}`;
    const before = provider.tokenRequests;
    expect((await request(path)).status).toBe(403);
    expect((await request(path, {headers: {cookie: `arenacore_oidc=${randomBytes(32).toString('base64url')}`}})).status).toBe(403);
    expect(provider.tokenRequests).toBe(before);
    expect(await db.authAttempt.count({where: {stateHash: hashToken(flow.state)}})).toBe(1);
    expect((await request(path, {headers: {cookie: flow.cookie}})).status).toBe(302);
  });
  it('rejects tampered state and expired attempts before exchanging code', async () => {
    const flow = await start(), before = provider.tokenRequests;
    expect((await request(`/auth/callback?${new URLSearchParams({state: randomBytes(32).toString('base64url'), code: 'code'})}`, {headers: {cookie: flow.cookie}})).status).toBe(403);
    await db.authAttempt.update({where: {stateHash: hashToken(flow.state)}, data: {expiresAt: new Date(Date.now()-1000)}});
    expect((await callback(flow)).status).toBe(403);
    expect(provider.tokenRequests).toBe(before);
  });
  it('allows only one exchange across concurrent callback replay', async () => {
    const flow = await start(), code = provider.issueCode(flow.authorization), before = provider.tokenRequests;
    const path = `/auth/callback?${new URLSearchParams({state: flow.state, code})}`;
    const responses = await Promise.all(Array.from({length: 4}, () => request(path, {headers: {cookie: flow.cookie}})));
    expect(responses.filter(r=>r.status === 302)).toHaveLength(1);
    expect(responses.filter(r=>r.status === 403)).toHaveLength(3);
    expect(provider.tokenRequests-before).toBe(1);
  });
  it.each(['wrong_nonce', 'wrong_issuer', 'wrong_audience', 'expired', 'bad_signature', 'no_id_token', 'token_failure'] as const)('rejects %s and returns no provider secrets', async scenario => {
    const sessions = await db.session.count({where: {user: {issuer: provider.issuer, subject: provider.subject}}});
    const response = await callback(await start(), scenario);
    expect(response.status).toBe(401);
    const result = await response.text();
    expect(result).not.toContain('PRIVATE_');
    expect(result).not.toContain('client_secret');
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await db.session.count({where: {user: {issuer: provider.issuer, subject: provider.subject}}})).toBe(sessions);
  });
  it('consumes provider-denied callbacks safely and does not exchange a token', async () => {
    const flow = await start(), before = provider.tokenRequests;
    const path = `/auth/callback?${new URLSearchParams({state: flow.state, error: 'access_denied', error_description: 'PRIVATE_PROVIDER_DIAGNOSTIC'})}`;
    const response = await request(path, {headers: {cookie: flow.cookie}});
    expect(response.status).toBe(401); expect(await response.text()).not.toContain('PRIVATE_PROVIDER_DIAGNOSTIC');
    expect(provider.tokenRequests).toBe(before);
    expect((await request(path, {headers: {cookie: flow.cookie}})).status).toBe(403);
  });
  it('rejects modified encrypted proof before contacting the provider', async () => {
    const flow = await start(), before = provider.tokenRequests;
    await db.authAttempt.update({where: {stateHash: hashToken(flow.state)}, data: {encryptedPayload: 'tampered'}});
    expect((await callback(flow)).status).toBe(401); expect(provider.tokenRequests).toBe(before);
  });
  it('rotates sessions on repeat login and keeps one issuer/subject account', async () => {
    const oldCookie = sessionCookie;
    const response = await callback(await start(), 'valid', oldCookie);
    expect(response.status).toBe(302);
    sessionCookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(sessionCookie).not.toBe(oldCookie);
    expect((await body<Me>(await request('/me', {headers: {cookie: oldCookie}}))).user).toBeNull();
    expect((await body<Me>(await request('/me', {headers: {cookie: sessionCookie}}))).user).not.toBeNull();
    expect(await db.user.count({where: {issuer: provider.issuer, subject: provider.subject}})).toBe(1);
  });
  it('sets Secure __Host cookies and uses configured origin despite spoofed Host headers', async () => {
    const oldMode = config.values.NODE_ENV, oldOrigin = config.values.PUBLIC_ORIGIN, oldApiOrigin = config.values.API_ORIGIN;
    config.values.NODE_ENV = 'production'; config.values.PUBLIC_ORIGIN = 'https://arena.example.test'; config.values.API_ORIGIN = 'https://api-arena.example.test';
    try {
      currentRateKeys();
      const response = await request('/auth/login', {headers: {host: 'attacker.example.test', 'x-forwarded-host': 'attacker.example.test'}});
      expect(response.status).toBe(302);
      const authorization = new URL(response.headers.get('location')!);
      expect(authorization.searchParams.get('redirect_uri')).toBe('https://api-arena.example.test/api/v1/auth/callback');
      const state = authorization.searchParams.get('state')!; stateHashes.add(hashToken(state));
      const cookieHeader = response.headers.getSetCookie()[0]!;
      expect(cookieHeader).toMatch(/^__Host-arenacore_oidc=/); expect(cookieHeader).toContain('Secure'); expect(cookieHeader).not.toContain('Domain=');
      const result = await callback({authorization, state, cookie: cookieHeader.split(';')[0]!});
      expect(result.status).toBe(302);
      expect(result.headers.getSetCookie()[0]).toMatch(/^__Host-arenacore_session=/);
      expect(result.headers.getSetCookie()[0]).toContain('Secure');
      expect(result.headers.get('location')).toBe('https://arena.example.test/problems');
    } finally {config.values.NODE_ENV = oldMode; config.values.PUBLIC_ORIGIN = oldOrigin; config.values.API_ORIGIN = oldApiOrigin;}
  });
  it('requires CSRF on logout and revokes the issued session', async () => {
    const me = await body<Me>(await request('/me', {headers: {cookie: sessionCookie}}));
    expect((await request('/auth/logout', {method: 'POST', headers: {cookie: sessionCookie, origin}})).status).toBe(403);
    const response = await request('/auth/logout', {method: 'POST', headers: {cookie: sessionCookie, origin, 'x-csrf-token': me.csrfToken!}});
    expect(response.status).toBe(200); expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0');
    expect((await request('/submissions', {headers: {cookie: sessionCookie}})).status).toBe(401);
  });
  it('rejects unsafe discovery and recovers after a provider outage', async () => {
    const gateway = new FixtureGateway(config, provider);
    const proof = {verifier: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url')};
    const state = randomBytes(32).toString('base64url');
    provider.failDiscovery = true;
    await expect(gateway.authorizationUrl(state, proof)).rejects.toThrow('temporarily unavailable');
    provider.failDiscovery = false;
    expect((await gateway.authorizationUrl(state, proof)).origin).toBe(provider.issuer);
    provider.metadataIssuer = 'https://attacker.example.test';
    try { await expect(new FixtureGateway(config, provider).authorizationUrl(state, proof)).rejects.toThrow('temporarily unavailable'); }
    finally {provider.metadataIssuer = provider.issuer;}
    provider.endpointProtocol = 'http:';
    try { await expect(new FixtureGateway(config, provider).authorizationUrl(state, proof)).rejects.toThrow('temporarily unavailable'); }
    finally {provider.endpointProtocol = 'https:';}
  });
  it('shares durable rate caps and ignores untrusted forwarded client IPs', async () => {
    await db.authRateLimit.deleteMany({where: {key: {in: currentRateKeys()}}});
    config.values.AUTH_LOGIN_REQUESTS_PER_MINUTE = 1;
    try {
      const first = await request('/auth/login', {headers: {'x-forwarded-for': '192.0.2.1'}});
      expect(first.status).toBe(302);
      stateHashes.add(hashToken(new URL(first.headers.get('location')!).searchParams.get('state')!));
      const response = await request('/auth/login', {headers: {'x-forwarded-for': '192.0.2.2'}});
      expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      const result = await body<{error: {code: string}}>(response);
      expect(result.error.code).toBe('LOGIN_RATE_LIMIT');
    } finally {config.values.AUTH_LOGIN_REQUESTS_PER_MINUTE = 100;}
  });
});
