import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request } from 'express';
import { ApiError } from '../common/errors';
import { Config } from '../config/config';
import { Database } from '../database/database';
import { LoginService } from './login.service';
import { hashPassword, verifyPassword } from './password';

@Injectable()
export class PasswordAuthService {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config, @Inject(LoginService) private readonly login: LoginService) {}
  private enabled() {
    if (!this.config.passwordAuthEnabled) throw new ApiError(503, 'IDENTITY_NOT_CONFIGURED', 'Email sign-in is not available yet.');
  }
  async register(req: Request, input: {email: string; password: string; displayName: string}) {
    this.enabled(); await this.login.protect(req, true);
    const email = input.email.trim().toLowerCase();
    const passwordHash = await hashPassword(input.password);
    let userId: string;
    try {
      const user = await this.db.user.create({data: {issuer: 'arenacore:password', subject: email, displayName: input.displayName.trim(), credential: {create: {email, passwordHash}}}, select: {id: true}});
      userId = user.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ApiError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Sign in instead.');
      throw error;
    }
    return this.login.issueUser(req, userId, 'AUTH_PASSWORD_REGISTER');
  }
  async authenticate(req: Request, input: {email: string; password: string}) {
    this.enabled(); await this.login.protect(req, true);
    const credential = await this.db.credential.findUnique({where: {email: input.email.trim().toLowerCase()}, select: {userId: true, passwordHash: true}});
    if (!await verifyPassword(input.password, credential?.passwordHash)) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    return this.login.issueUser(req, credential!.userId);
  }
}
