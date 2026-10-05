import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { serialize } from 'cookie';
import { Config } from '../config/config';
import { ApiError, validate } from '../common/errors';
import { z } from 'zod';
import { LoginService, LOGIN_TTL_SECONDS } from './login.service';
import { Database } from '../database/database';
import { AllowRestricted, AuthenticatedRequest, Sessions, SessionGuard } from './session';
import { PasswordAuthService } from './password-auth.service';
import { usernameSchema } from '@arenacore/contracts';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(12).max(128).refine(value => Buffer.byteLength(value, 'utf8') <= 256);
const displayName = z.string().trim().min(2).max(120).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const returnTo = z.string().max(500).refine(value => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'), 'Return path must stay within ArenaCore');

@Controller()
export class AuthController {
  constructor(@Inject(Sessions) private readonly sessions: Sessions, @Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config, @Inject(LoginService) private readonly loginService: LoginService, @Inject(PasswordAuthService) private readonly passwordAuth: PasswordAuthService) {}
  @Get('auth/providers')
  providers() {
    // This exposes only the enabled choices, never client IDs, secrets, or
    // provider account details. It lets the browser avoid dead provider links.
    return {
      password: this.config.passwordAuthEnabled,
      google: this.config.values.GOOGLE_AUTH_ENABLED === 'true',
      github: this.config.values.GITHUB_AUTH_ENABLED === 'true',
    };
  }
  @Get('auth/login')
  async login(@Req() req: Request, @Query() query: unknown, @Res() res: Response) {
    const {provider,returnTo:path} = validate(z.strictObject({provider: z.enum(['auth0', 'google', 'github']).default('auth0'),returnTo:returnTo.default('/problems')}), query);
    const {location, browserToken} = await this.loginService.begin(req, provider,path);
    res.setHeader('Set-Cookie', serialize(this.config.loginCookieName, browserToken, {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: LOGIN_TTL_SECONDS}));
    res.redirect(302, location);
  }
  private setSessionCookie(res: Response, session: {token: string; expiresAt: Date}) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', serialize(this.config.cookieName, session.token, {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: this.config.values.SESSION_TTL_SECONDS, expires: session.expiresAt}));
  }
  @Post('auth/register')
  @HttpCode(201)
  async register(@Req() req: Request, @Body() body: unknown, @Res({passthrough: true}) res: Response) {
    const input = validate(z.strictObject({email, password, displayName,username:usernameSchema}), body);
    const session = await this.passwordAuth.register(req, input);
    this.setSessionCookie(res, session);
    return {ok: true};
  }
  @Post('auth/password')
  @HttpCode(200)
  async passwordLogin(@Req() req: Request, @Body() body: unknown, @Res({passthrough: true}) res: Response) {
    const input = validate(z.strictObject({email, password}), body);
    const session = await this.passwordAuth.authenticate(req, input);
    this.setSessionCookie(res, session);
    return {ok: true};
  }
  @Get('auth/callback')
  async callback(@Req() req: Request, @Query() query: unknown, @Res() res: Response) {
    if (req.originalUrl.length > 4096) throw new ApiError(400, 'INVALID_REQUEST', 'Sign-in callback is too large.');
    const params = validate(z.strictObject({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(2048).optional(),
      error: z.string().min(1).max(100).optional(), error_description: z.string().max(512).optional(),
      error_uri: z.string().max(512).optional(), iss: z.string().max(2048).optional(), session_state: z.string().max(512).optional(),
    }).refine(value => Boolean(value.code) !== Boolean(value.error), 'Exactly one code or error is required'), query);
    let session;
    try {session = await this.loginService.finish(req, Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)));}
    catch (error) {
      if (!params.error||!(error instanceof ApiError)||error.getStatus()!==401) throw error;
      res.setHeader('Set-Cookie',serialize(this.config.loginCookieName,'',{httpOnly:true,secure:this.config.secureCookies,sameSite:'lax',path:'/',maxAge:0}));
      return res.redirect(302,`${this.config.values.PUBLIC_ORIGIN}/sign-in?authError=provider`);
    }
    res.setHeader('Set-Cookie', [
      serialize(this.config.cookieName, session.token, {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: this.config.values.SESSION_TTL_SECONDS, expires: session.expiresAt}),
      serialize(this.config.loginCookieName, '', {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: 0}),
    ]);
    res.redirect(302, `${this.config.values.PUBLIC_ORIGIN}${session.returnTo}`);
  }
  @Get('me')
  async me(@Req() req: Request, @Res({passthrough: true}) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const principal = await this.sessions.resolve(req);
    if (!principal) return {user: null};
    return {user: {id: principal.userId, username: principal.username, displayName: principal.displayName, avatarUrl:principal.avatarUrl, themePreference:principal.themePreference, role: principal.role,restriction:principal.restriction}, csrfToken: principal.csrfToken};
  }
  @Post('auth/logout')
  @HttpCode(200)
  @AllowRestricted()
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthenticatedRequest, @Res({passthrough: true}) res: Response) {
    await this.db.$transaction(async tx => {
      await tx.session.update({where: {id: req.principal.sessionId}, data: {revokedAt: new Date()}});
      await tx.auditEvent.create({data: {actorId: req.principal.userId, action: 'AUTH_LOGOUT', targetId: req.principal.userId}});
    });
    res.setHeader('Set-Cookie', serialize(this.config.cookieName, '', {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: 0}));
    return {ok: true};
  }
}
