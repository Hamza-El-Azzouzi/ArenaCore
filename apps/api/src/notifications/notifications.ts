import {Controller, Get, Inject, Injectable, Param, Patch, Query, Req, UseGuards} from '@nestjs/common';
import {z} from 'zod';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';
import {ApiError, validate} from '../common/errors';
import {Database} from '../database/database';

const uuid=z.uuid();
const querySchema=z.strictObject({cursor:uuid.optional()});

@Injectable()
export class Notifications {
  constructor(@Inject(Database) private readonly db:Database){}

  async list(userId:string,cursor?:string){
    const boundary=cursor?await this.db.notification.findFirst({where:{id:cursor,userId},select:{id:true,createdAt:true}}):null;
    if(cursor&&!boundary)throw new ApiError(400,'INVALID_CURSOR','Notification cursor is invalid.');
    const rows=await this.db.notification.findMany({where:{userId,...(boundary?{OR:[{createdAt:{lt:boundary.createdAt}},{createdAt:boundary.createdAt,id:{lt:boundary.id}}]}:{})},select:{id:true,kind:true,title:true,body:true,href:true,readAt:true,createdAt:true},orderBy:[{createdAt:'desc'},{id:'desc'}],take:31});
    const items=rows.slice(0,30).map(item=>({...item,readAt:item.readAt?.toISOString()??null,createdAt:item.createdAt.toISOString()}));
    return {items,nextCursor:rows.length>30?items.at(-1)!.id:null,unreadCount:await this.db.notification.count({where:{userId,readAt:null}})};
  }

  async unreadCount(userId:string){return {unreadCount:await this.db.notification.count({where:{userId,readAt:null}})};}

  async markRead(userId:string,id:string){
    const now=new Date(),result=await this.db.notification.updateMany({where:{id,userId,readAt:null},data:{readAt:now}});
    if(!result.count&&!await this.db.notification.findFirst({where:{id,userId},select:{id:true}}))throw new ApiError(404,'NOT_FOUND','Notification not found.');
    return {id,readAt:result.count?now.toISOString():(await this.db.notification.findUniqueOrThrow({where:{id},select:{readAt:true}})).readAt?.toISOString()??null};
  }

  async markAllRead(userId:string){const result=await this.db.notification.updateMany({where:{userId,readAt:null},data:{readAt:new Date()}});return {updated:result.count};}
}

@Controller('notifications')
@UseGuards(SessionGuard)
export class NotificationsController {
  constructor(@Inject(Notifications) private readonly notifications:Notifications){}
  @Get() list(@Req() req:AuthenticatedRequest,@Query() query:unknown){return this.notifications.list(req.principal.userId,validate(querySchema,query).cursor);}
  @Get('unread-count') unreadCount(@Req() req:AuthenticatedRequest){return this.notifications.unreadCount(req.principal.userId);}
  @Patch('read-all') markAllRead(@Req() req:AuthenticatedRequest){return this.notifications.markAllRead(req.principal.userId);}
  @Patch(':id/read') markRead(@Req() req:AuthenticatedRequest,@Param('id') id:string){return this.notifications.markRead(req.principal.userId,validate(uuid,id));}
}
