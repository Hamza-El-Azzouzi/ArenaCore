import { Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { parse } from 'cookie';
import { createHmac, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Database } from '../database/database';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';
import { OidcGateway, SocialProvider, VerifiedIdentity } from './oidc.gateway';
import { GithubGateway } from './github.gateway';
import { decryptProof, encryptProof } from './login-proof';
import { hashToken, newSessionSecrets } from './session';

export const LOGIN_TTL_SECONDS = 300;
const validToken = /^[A-Za-z0-9_-]{43}$/;
@Injectable()
export class LoginService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config, @Inject(OidcGateway) private readonly oidc: OidcGateway, @Inject(GithubGateway) private readonly github: GithubGateway) {}
  private key() {
    if (!this.config.authTransactionKey) throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'Sign-in is not available yet.');
    return Buffer.from(this.config.authTransactionKey, 'base64');
  }
  private async limit(ip: string) {
    const now = new Date();
    const window = Math.floor(now.getTime() / 60000);
    const expiresAt = new Date((window + 1) * 60000);
    const key = this.key();
    const scope = (value: string) => createHmac('sha256', key).update(`auth:${window}:${value}`).digest('hex');
    const counts = await this.db.$transaction(async tx => {
      await tx.authRateLimit.deleteMany({where: {expiresAt: {lte: now}}});
      const global = await tx.authRateLimit.upsert({where: {key: scope('global')}, create: {key: scope('global'), expiresAt}, update: {count: {increment: 1}}});
      const client = await tx.authRateLimit.upsert({where: {key: scope(`ip:${ip}`)}, create: {key: scope(`ip:${ip}`), expiresAt}, update: {count: {increment: 1}}});
      return {global: global.count, client: client.count};
    });
    if (counts.client > this.config.values.AUTH_LOGIN_REQUESTS_PER_MINUTE || counts.global > this.config.values.AUTH_LOGIN_GLOBAL_PER_MINUTE) {
      throw new ApiError(429, 'LOGIN_RATE_LIMIT', 'Too many sign-in requests. Please wait and retry.', Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)));
    }
  }
  async protect(req: Request, requireOrigin = false) {
    const key = this.key();
    if ((requireOrigin && req.headers.origin !== this.config.values.PUBLIC_ORIGIN) || (req.headers.origin && req.headers.origin !== this.config.values.PUBLIC_ORIGIN) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'INVALID_ORIGIN', 'Start sign-in from ArenaCore.');
    }
    await this.limit(req.ip ?? req.socket.remoteAddress ?? 'unknown');
    return key;
  }
  async begin(req: Request, provider: SocialProvider = 'auth0') {
    const key = await this.protect(req);
    const state = randomBytes(32).toString('base64url');
    const browserToken = randomBytes(32).toString('base64url');
    const proof = {provider, verifier: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url')};
    const location = provider === 'github' ? this.github.authorizationUrl(state, proof) : await this.oidc.authorizationUrl(state, proof);
    const stateHash = hashToken(state);
    const oldBrowserToken = parse(req.headers.cookie ?? '')[this.config.loginCookieName];
    await this.db.$transaction(async tx => {
      await tx.authAttempt.deleteMany({where: {OR: [{expiresAt: {lte: new Date()}}, ...(oldBrowserToken && validToken.test(oldBrowserToken) ? [{browserTokenHash: hashToken(oldBrowserToken)}] : [])]}});
      await tx.authAttempt.create({data: {stateHash, browserTokenHash: hashToken(browserToken), encryptedPayload: encryptProof(key, stateHash, proof), expiresAt: new Date(Date.now() + LOGIN_TTL_SECONDS * 1000)}});
    });
    return {location: location.toString(), browserToken};
  }
  async finish(req: Request, params: Record<string, string>) {
    const key = this.key();
    const browserToken = parse(req.headers.cookie ?? '')[this.config.loginCookieName];
    if (!browserToken || !validToken.test(browserToken)) throw new ApiError(403, 'INVALID_LOGIN_STATE', 'Sign-in browser state is missing. Please start again.');
    const state = params.state!;
    const stateHash = hashToken(state);
    const attempt = await this.db.authAttempt.findUnique({where: {stateHash}});
    if (!attempt) throw new ApiError(403, 'INVALID_LOGIN_STATE', 'Sign-in has expired or was already used. Please start again.');
    const consumed = await this.db.authAttempt.deleteMany({where: {stateHash, browserTokenHash: hashToken(browserToken), expiresAt: {gt: new Date()}}});
    if (consumed.count !== 1) throw new ApiError(403, 'INVALID_LOGIN_STATE', 'Sign-in state could not be verified. Please start again.');
    let proof;
    try { proof = decryptProof(key, stateHash, attempt.encryptedPayload); }
    catch { throw new ApiError(401, 'LOGIN_FAILED', 'Sign-in could not be verified. Please start again.'); }
    // Never trust request Host or forwarded headers to build the redirect URI.
    const callback = new URL(this.config.callbackUrl);
    callback.search = new URLSearchParams(params).toString();
    const identity = proof.provider === 'github' ? await this.github.exchange(callback, state, proof) : await this.oidc.exchange(callback, state, proof);
    return this.issueIdentity(req, identity);
  }
  async issueIdentity(req: Request, identity: VerifiedIdentity) {
    const session = newSessionSecrets();
    const expiresAt = new Date(Date.now() + this.config.values.SESSION_TTL_SECONDS * 1000);
    await this.db.$transaction(async tx => {
      const user = await tx.user.upsert({where: {issuer_subject: {issuer: identity.issuer, subject: identity.subject}}, create: identity, update: {displayName: identity.displayName}});
      // Role is owned by the database; provider profile/role claims cannot grant ADMIN.
      await this.persistSession(tx, req, user.id, 'AUTH_LOGIN', session, expiresAt);
    });
    return {token: session.token, expiresAt};
  }
  async issueUser(req: Request, userId: string, action = 'AUTH_PASSWORD_LOGIN') {
    const session = newSessionSecrets();
    const expiresAt = new Date(Date.now() + this.config.values.SESSION_TTL_SECONDS * 1000);
    await this.db.$transaction(async tx => {
      const user = await tx.user.findUnique({where: {id: userId}, select: {id: true}});
      if (!user) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      await this.persistSession(tx, req, user.id, action, session, expiresAt);
    });
    return {token: session.token, expiresAt};
  }
  private async persistSession(tx: Prisma.TransactionClient, req: Request, userId: string, action: string, session: ReturnType<typeof newSessionSecrets>, expiresAt: Date) {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    const oldSession = parse(req.headers.cookie ?? '')[this.config.cookieName];
    if (oldSession && validToken.test(oldSession)) await tx.session.updateMany({where: {tokenHash: hashToken(oldSession), revokedAt: null}, data: {revokedAt: new Date()}});
    await tx.session.deleteMany({where: {userId, expiresAt: {lte: new Date()}}});
    const active = await tx.session.findMany({where: {userId, revokedAt: null, expiresAt: {gt: new Date()}}, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], select: {id: true}});
    if (active.length >= 10) await tx.session.updateMany({where: {id: {in: active.slice(9).map(item => item.id)}}, data: {revokedAt: new Date()}});
    await tx.session.create({data: {userId, tokenHash: session.tokenHash, csrfTokenHash: session.csrfTokenHash, expiresAt}});
    await tx.auditEvent.create({data: {actorId: userId, action, targetId: userId}});
  }
}
