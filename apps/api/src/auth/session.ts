import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {Role} from '@prisma/client';
import { parse } from 'cookie';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { Database } from '../database/database';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';

export interface Principal { userId: string; username: string; displayName: string; avatarUrl:string|null; themePreference:'SYSTEM'|'DARK'|'LIGHT'; role: Role; sessionId: string; csrfTokenHash: string; csrfToken: string; restriction:{kind:'BANNED'|'SUSPENDED';reason:string|null;until:string|null}|null }
export type AuthenticatedRequest = Request & { principal: Principal };
const ALLOW_RESTRICTED_KEY='arenacore:allow-restricted';
export const AllowRestricted=()=>SetMetadata(ALLOW_RESTRICTED_KEY,true);
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
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()||session.user.deactivatedAt) return null;
    const restriction=session.user.bannedAt?{kind:'BANNED' as const,reason:session.user.restrictionReason,until:null}:session.user.suspendedUntil&&session.user.suspendedUntil.getTime()>Date.now()?{kind:'SUSPENDED' as const,reason:session.user.restrictionReason,until:session.user.suspendedUntil.toISOString()}:null;
    return {userId: session.userId, username: session.user.username, displayName: session.user.displayName,avatarUrl:session.user.avatarUrl,themePreference:session.user.themePreference, role: session.user.role, sessionId: session.id, csrfTokenHash: session.csrfTokenHash, csrfToken: csrfForSession(token),restriction};
  }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Sessions) private readonly sessions: Sessions, @Inject(Config) private readonly config: Config,@Inject(Reflector) private readonly reflector:Reflector) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.sessions.resolve(req);
    if (!principal) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    req.principal = principal;
    const allowRestricted=this.reflector.getAllAndOverride<boolean>(ALLOW_RESTRICTED_KEY,[context.getHandler(),context.getClass()]);
    if(principal.restriction&&!allowRestricted){
      if(principal.restriction.kind==='BANNED')throw new ApiError(403,'ACCOUNT_BANNED','This account has been banned. Contact support if you believe this is a mistake.');
      const retry=Math.max(1,Math.ceil((Date.parse(principal.restriction.until!)-Date.now())/1000));
      throw new ApiError(403,'ACCOUNT_SUSPENDED','This account is temporarily suspended.',retry);
    }
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
