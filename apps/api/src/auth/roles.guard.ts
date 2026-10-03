import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import {Role} from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/errors';
import { AuthenticatedRequest } from './session';
const ROLES_KEY = 'arenacore:roles';
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext) {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.principal) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
    if (!roles.includes(req.principal.role)) throw new ApiError(403, 'PERMISSION_DENIED', 'You do not have permission for this action.');
    return true;
  }
}
