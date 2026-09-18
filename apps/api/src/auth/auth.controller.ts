import { Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { serialize } from 'cookie';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';
import { Database } from '../database/database';
import { AuthenticatedRequest, Sessions, SessionGuard } from './session';

@Controller()
export class AuthController {
  constructor(@Inject(Sessions) private readonly sessions: Sessions, @Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config) {}
  @Get('auth/login')
  login() { throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'Sign-in is not available yet.'); }
  @Get('me')
  async me(@Req() req: Request, @Res({passthrough: true}) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const principal = await this.sessions.resolve(req);
    if (!principal) return {user: null};
    return {user: {id: principal.userId, displayName: principal.displayName}, csrfToken: principal.csrfToken};
  }
  @Post('auth/logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async logout(@Req() req: AuthenticatedRequest, @Res({passthrough: true}) res: Response) {
    await this.db.session.update({where: {id: req.principal.sessionId}, data: {revokedAt: new Date()}});
    res.setHeader('Set-Cookie', serialize(this.config.cookieName, '', {httpOnly: true, secure: this.config.values.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0}));
    return {ok: true};
  }
}
