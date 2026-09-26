import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthController } from './auth.controller';
import { LoginService } from './login.service';
import { OidcGateway } from './oidc.gateway';
import { GithubGateway } from './github.gateway';
import { PasswordAuthService } from './password-auth.service';
import { RolesGuard } from './roles.guard';
import { Sessions, SessionGuard } from './session';
@Module({
  imports: [DatabaseModule], controllers: [AuthController],
  providers: [Sessions, SessionGuard, LoginService, OidcGateway, GithubGateway, PasswordAuthService, RolesGuard],
  exports: [Sessions, SessionGuard, RolesGuard],
})
export class AuthModule {}
