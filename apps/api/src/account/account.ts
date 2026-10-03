import {Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Patch, Req, Res, UseGuards} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {Response} from 'express';
import {serialize} from 'cookie';
import {z} from 'zod';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';
import {hashPassword, verifyPassword} from '../auth/password';
import {ApiError, validate} from '../common/errors';
import {Config} from '../config/config';
import {Database} from '../database/database';

const uuid=z.uuid();
const password=z.string().min(12).max(128).refine(value=>Buffer.byteLength(value,'utf8')<=256);
const email=z.string().trim().toLowerCase().email().max(254);
const settingsSchema=z.strictObject({
  profileVisibility:z.enum(['PUBLIC','PRIVATE']).optional(),
  themePreference:z.enum(['SYSTEM','DARK','LIGHT']).optional(),
  productNotifications:z.boolean().optional(),
  competitionNotifications:z.boolean().optional(),
}).refine(value=>Object.keys(value).length>0,'At least one setting is required');
const passwordSchema=z.strictObject({currentPassword:password,newPassword:password}).refine(value=>value.currentPassword!==value.newPassword,{path:['newPassword'],message:'New password must be different'});
const emailSchema=z.strictObject({currentPassword:password,newEmail:email});
const deactivateSchema=z.strictObject({confirmation:z.literal('DELETE'),currentPassword:password.optional()});

@Injectable()
export class AccountService {
  constructor(@Inject(Database) private readonly db:Database){}

  async settings(userId:string){
    const user=await this.db.user.findUnique({where:{id:userId},select:{username:true,displayName:true,avatarUrl:true,profileVisibility:true,themePreference:true,productNotifications:true,competitionNotifications:true,credential:{select:{email:true}}}});
    if(!user)throw new ApiError(404,'NOT_FOUND','Account not found.');
    const {credential,...profile}=user;
    return {...profile,hasPassword:Boolean(credential),email:credential?.email??null};
  }

  async updateSettings(userId:string,input:z.infer<typeof settingsSchema>){
    return this.db.$transaction(async tx=>{
      const updated=await tx.user.update({where:{id:userId},data:input,select:{profileVisibility:true,themePreference:true,productNotifications:true,competitionNotifications:true}});
      await tx.auditEvent.create({data:{actorId:userId,action:'ACCOUNT_SETTINGS_UPDATE',targetId:userId}});
      return updated;
    });
  }

  async sessions(userId:string,currentSessionId:string){
    const rows=await this.db.session.findMany({where:{userId,revokedAt:null,expiresAt:{gt:new Date()}},select:{id:true,createdAt:true,expiresAt:true},orderBy:[{createdAt:'desc'},{id:'desc'}]});
    return {items:rows.map(row=>({id:row.id,current:row.id===currentSessionId,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString()}))};
  }

  async revokeSession(userId:string,currentSessionId:string,sessionId:string){
    const session=await this.db.session.findFirst({where:{id:sessionId,userId,revokedAt:null},select:{id:true}});
    if(!session)throw new ApiError(404,'NOT_FOUND','Active session not found.');
    await this.db.$transaction(async tx=>{
      await tx.session.update({where:{id:sessionId},data:{revokedAt:new Date()}});
      await tx.auditEvent.create({data:{actorId:userId,action:sessionId===currentSessionId?'ACCOUNT_CURRENT_SESSION_REVOKE':'ACCOUNT_SESSION_REVOKE',targetId:sessionId}});
    });
    return {revoked:true,current:sessionId===currentSessionId};
  }

  async revokeOtherSessions(userId:string,currentSessionId:string){
    const result=await this.db.$transaction(async tx=>{
      const changed=await tx.session.updateMany({where:{userId,id:{not:currentSessionId},revokedAt:null,expiresAt:{gt:new Date()}},data:{revokedAt:new Date()}});
      await tx.auditEvent.create({data:{actorId:userId,action:'ACCOUNT_OTHER_SESSIONS_REVOKE',targetId:userId}});
      return changed.count;
    });
    return {revoked:result};
  }

  async changePassword(userId:string,currentSessionId:string,input:z.infer<typeof passwordSchema>){
    const credential=await this.db.credential.findUnique({where:{userId},select:{id:true,passwordHash:true}});
    if(!credential)throw new ApiError(409,'PASSWORD_NOT_AVAILABLE','This account signs in through an external provider and has no ArenaCore password.');
    if(!await verifyPassword(input.currentPassword,credential.passwordHash))throw new ApiError(401,'INVALID_CREDENTIALS','Current password is incorrect.');
    const passwordHash=await hashPassword(input.newPassword);
    await this.db.$transaction(async tx=>{
      await tx.credential.update({where:{id:credential.id},data:{passwordHash}});
      await tx.session.updateMany({where:{userId,id:{not:currentSessionId},revokedAt:null},data:{revokedAt:new Date()}});
      await tx.auditEvent.create({data:{actorId:userId,action:'ACCOUNT_PASSWORD_CHANGE',targetId:userId}});
    });
    return {changed:true};
  }

  async changeEmail(userId:string,currentSessionId:string,input:z.infer<typeof emailSchema>){
    const credential=await this.db.credential.findUnique({where:{userId},select:{id:true,email:true,passwordHash:true}});
    if(!credential)throw new ApiError(409,'EMAIL_NOT_AVAILABLE','This account signs in through an external provider and has no ArenaCore email credential.');
    if(!await verifyPassword(input.currentPassword,credential.passwordHash))throw new ApiError(401,'INVALID_CREDENTIALS','Current password is incorrect.');
    const newEmail=input.newEmail.trim().toLowerCase();
    if(newEmail===credential.email)return {changed:false,email:credential.email};
    try{return await this.db.$transaction(async tx=>{
      await tx.credential.update({where:{id:credential.id},data:{email:newEmail}});
      await tx.user.update({where:{id:userId},data:{subject:newEmail}});
      await tx.session.updateMany({where:{userId,id:{not:currentSessionId},revokedAt:null},data:{revokedAt:new Date()}});
      await tx.auditEvent.create({data:{actorId:userId,action:'ACCOUNT_EMAIL_CHANGE',targetId:userId}});
      return {changed:true,email:newEmail};
    });}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new ApiError(409,'EMAIL_TAKEN','An account already uses this email.');throw error;}
  }

  async deactivate(userId:string,input:z.infer<typeof deactivateSchema>){
    const credential=await this.db.credential.findUnique({where:{userId},select:{passwordHash:true}});
    if(credential&&(!input.currentPassword||!await verifyPassword(input.currentPassword,credential.passwordHash)))throw new ApiError(401,'INVALID_CREDENTIALS','Current password is required to deactivate this account.');
    const suffix=randomUUID().replaceAll('-','');
    await this.db.$transaction(async tx=>{
      await tx.session.updateMany({where:{userId,revokedAt:null},data:{revokedAt:new Date()}});
      await tx.credential.deleteMany({where:{userId}});
      await tx.competition.updateMany({where:{ownerId:userId},data:{ownerId:null}});
      await tx.competitionRegistration.deleteMany({where:{userId}});
      await tx.discussionLike.deleteMany({where:{userId}});
      await tx.discussionRateLimit.deleteMany({where:{userId}});
      await tx.user.update({where:{id:userId},data:{issuer:'arenacore:deleted',subject:suffix,username:`deleted_${suffix.slice(0,24)}`,displayName:'Deleted user',bio:null,location:null,website:null,avatarUrl:null,profileVisibility:'PRIVATE',productNotifications:false,competitionNotifications:false,deactivatedAt:new Date()}});
      await tx.auditEvent.create({data:{actorId:userId,action:'ACCOUNT_DEACTIVATE',targetId:userId}});
    });
    return {deactivated:true};
  }
}

@Controller('account')
@UseGuards(SessionGuard)
export class AccountController {
  constructor(@Inject(AccountService) private readonly account:AccountService,@Inject(Config) private readonly config:Config){}
  private clearCookie(res:Response){res.setHeader('Set-Cookie',serialize(this.config.cookieName,'',{httpOnly:true,secure:this.config.secureCookies,sameSite:'lax',path:'/',maxAge:0}));}
  @Get('settings') settings(@Req() req:AuthenticatedRequest){return this.account.settings(req.principal.userId);}
  @Patch('settings') updateSettings(@Req() req:AuthenticatedRequest,@Body() body:unknown){return this.account.updateSettings(req.principal.userId,validate(settingsSchema,body));}
  @Get('sessions') sessions(@Req() req:AuthenticatedRequest){return this.account.sessions(req.principal.userId,req.principal.sessionId);}
  @Delete('sessions') @HttpCode(200) revokeOthers(@Req() req:AuthenticatedRequest){return this.account.revokeOtherSessions(req.principal.userId,req.principal.sessionId);}
  @Delete('sessions/:id') @HttpCode(200)
  async revoke(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Res({passthrough:true}) res:Response){const result=await this.account.revokeSession(req.principal.userId,req.principal.sessionId,validate(uuid,id));if(result.current)this.clearCookie(res);return result;}
  @Patch('password') changePassword(@Req() req:AuthenticatedRequest,@Body() body:unknown){return this.account.changePassword(req.principal.userId,req.principal.sessionId,validate(passwordSchema,body));}
  @Patch('email') changeEmail(@Req() req:AuthenticatedRequest,@Body() body:unknown){return this.account.changeEmail(req.principal.userId,req.principal.sessionId,validate(emailSchema,body));}
  @Delete() @HttpCode(200)
  async deactivate(@Req() req:AuthenticatedRequest,@Body() body:unknown,@Res({passthrough:true}) res:Response){const result=await this.account.deactivate(req.principal.userId,validate(deactivateSchema,body));this.clearCookie(res);return result;}
}
