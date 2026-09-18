import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { parse } from 'cookie';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { Database } from '../database/database';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';

export interface Principal { userId: string; displayName: string; role: 'USER' | 'ADMIN'; sessionId: string; csrfTokenHash: string; csrfToken: string }
export type AuthenticatedRequest = Request & { principal: Principal };
export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function hashesEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
export function csrfForSession(token: string): string { return createHmac('sha256', token).update('ArenaCore:csrf:v1').digest('base64url'); }
export function newSessionSecrets() {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = csrfForSession(token);
  return {token, csrfToken, tokenHash: hashToken(token), csrfTokenHash: hashToken(csrfToken)};
}
@Injectable()
export class Sessions {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config) {}
  async resolve(req: Request): Promise<Principal | null> {
    const cookies = parse(req.headers.cookie ?? '');
    const token = cookies[this.config.cookieName];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = await this.db.session.findUnique({where: {tokenHash: hashToken(token)}, include: {user: true}});
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    return {userId: session.userId, displayName: session.user.displayName, role: session.user.role, sessionId: session.id, csrfTokenHash: session.csrfTokenHash, csrfToken: csrfForSession(token)};
  }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Sessions) private readonly sessions: Sessions, @Inject(Config) private readonly config: Config) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.sessions.resolve(req);
    if (!principal) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    req.principal = principal;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== this.config.values.PUBLIC_ORIGIN) throw new ApiError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
      const csrf = req.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !hashesEqual(hashToken(csrf), principal.csrfTokenHash)) {
        throw new ApiError(403, 'INVALID_CSRF_TOKEN', 'CSRF token is missing or invalid.');
      }
    }
    return true;
  }
}
