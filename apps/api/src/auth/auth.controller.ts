import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { serialize } from 'cookie';
import { Config } from '../config/config';
import { ApiError, validate } from '../common/errors';
import { z } from 'zod';
import { LoginService, LOGIN_TTL_SECONDS } from './login.service';
import { Database } from '../database/database';
import { AuthenticatedRequest, Sessions, SessionGuard } from './session';

@Controller()
export class AuthController {
  constructor(@Inject(Sessions) private readonly sessions: Sessions, @Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config, @Inject(LoginService) private readonly loginService: LoginService) {}
  @Get('auth/login')
  async login(@Req() req: Request, @Query() query: unknown, @Res() res: Response) {
    validate(z.strictObject({}), query);
    const {location, browserToken} = await this.loginService.begin(req);
    res.setHeader('Set-Cookie', serialize(this.config.loginCookieName, browserToken, {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: LOGIN_TTL_SECONDS}));
    res.redirect(302, location);
  }
  @Get('auth/callback')
  async callback(@Req() req: Request, @Query() query: unknown, @Res() res: Response) {
    if (req.originalUrl.length > 4096) throw new ApiError(400, 'INVALID_REQUEST', 'Sign-in callback is too large.');
    const params = validate(z.strictObject({
      state: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code: z.string().min(1).max(2048).optional(),
      error: z.string().min(1).max(100).optional(), error_description: z.string().max(512).optional(),
      error_uri: z.string().max(512).optional(), iss: z.string().max(2048).optional(), session_state: z.string().max(512).optional(),
    }).refine(value => Boolean(value.code) !== Boolean(value.error), 'Exactly one code or error is required'), query);
    const session = await this.loginService.finish(req, Object.fromEntries(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)));
    res.setHeader('Set-Cookie', [
      serialize(this.config.cookieName, session.token, {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: this.config.values.SESSION_TTL_SECONDS, expires: session.expiresAt}),
      serialize(this.config.loginCookieName, '', {httpOnly: true, secure: this.config.secureCookies, sameSite: 'lax', path: '/', maxAge: 0}),
    ]);
    res.redirect(302, `${this.config.values.PUBLIC_ORIGIN}/problems`);
  }
  @Get('me')
  async me(@Req() req: Request, @Res({passthrough: true}) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const principal = await this.sessions.resolve(req);
    if (!principal) return {user: null};
    return {user: {id: principal.userId, username: principal.username, displayName: principal.displayName}, csrfToken: principal.csrfToken};
  }
  @Post('auth/logout')
  @HttpCode(200)
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
