import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Server, Socket } from 'socket.io';
import type { Request } from 'express';
import { executionSubscriptionSchema } from '@arenacore/contracts';
import { Sessions } from '../auth/session';
import { Config } from '../config/config';
import { JobStore } from './job-store';
import { ApiError } from '../common/errors';

interface Cursor {executionId:string;attempt:number;afterSequence:number}
interface ClientState {userId:string;subscriptions:Map<string,Cursor>;commandBusy:boolean;polling?:Promise<void>;requests:number;window:number}
@Injectable()
export class ExecutionRealtime implements OnApplicationBootstrap,OnModuleDestroy {
  private authenticating=0;
  private io?:Server; private timer?:NodeJS.Timeout; private polling?:Promise<void>;
  private readonly clients=new Map<Socket,ClientState>();
  constructor(@Inject(HttpAdapterHost) private readonly http:HttpAdapterHost,@Inject(Sessions) private readonly sessions:Sessions,@Inject(Config) private readonly config:Config,@Inject(JobStore) private readonly jobs:JobStore) {}
  onApplicationBootstrap() {
    if (this.config.values.REALTIME_ENABLED!=='true') return;
    const origin=this.config.values.PUBLIC_ORIGIN;
    this.io=new Server(this.http.httpAdapter.getHttpServer(),{transports:['websocket'],maxHttpBufferSize:16384,perMessageDeflate:false,allowRequest:(req,done)=>done(null,req.headers.origin===origin && (this.io?.engine.clientsCount ?? 0)<500)});
    const ns=this.io.of('/executions');
    ns.use(async(socket,next)=>{
      if (this.authenticating>=20) {next(new Error('CAPACITY_REQUIRED'));setTimeout(()=>socket.conn.close(),100).unref();return;}
      this.authenticating++;
      try {
        const principal=await this.sessions.resolve(socket.request as Request);
        const ip=socket.conn.remoteAddress;
        if (!principal || this.clients.size>=500 || [...this.clients].filter(([s,c])=>c.userId===principal.userId).length>=5 || [...this.clients.keys()].filter(s=>s.conn.remoteAddress===ip).length>=20) {next(new Error('AUTHENTICATION_OR_CAPACITY_REQUIRED'));setTimeout(()=>socket.conn.close(),100).unref();return;}
        socket.data.userId=principal.userId; next();
      } catch {next(new Error('AUTHENTICATION_REQUIRED'));setTimeout(()=>socket.conn.close(),100).unref();} finally {this.authenticating--;}
    });
    ns.on('connection',socket=>{
      const client:ClientState={userId:socket.data.userId as string,subscriptions:new Map<string,Cursor>(),commandBusy:false,requests:0,window:Date.now()};
      this.clients.set(socket,client);
      socket.on('disconnect',()=>{this.clients.delete(socket);});
      socket.on('subscribe_execution',async(input:unknown,ack:unknown)=>{
        if (typeof ack!=='function') return socket.disconnect(true);
        const reply=ack as (value:unknown)=>void;
        if (Date.now()-client.window>=60000) {client.window=Date.now();client.requests=0;}
        if (++client.requests>60 || client.commandBusy) return reply({ok:false,error:{code:'SOCKET_RATE_LIMIT'}});
        const parsed=executionSubscriptionSchema.safeParse(input);
        if (!parsed.success) return reply({ok:false,error:{code:'INVALID_REQUEST'}});
        if (!client.subscriptions.has(parsed.data.executionId) && client.subscriptions.size>=5) return reply({ok:false,error:{code:'SUBSCRIPTION_LIMIT'}});
        client.commandBusy=true;
        try {
          await client.polling;
          if (!socket.connected) return;
          const principal=await this.sessions.resolve(socket.request as Request);
          if (!principal || principal.userId!==client.userId) {socket.disconnect(true);return;}
          const result=await this.jobs.replay(client.userId,parsed.data.executionId,parsed.data.attempt,parsed.data.afterSequence);
          // Ack contains replay; live delivery resumes strictly after its snapshot.
          if (!socket.connected) return;
          client.subscriptions.set(parsed.data.executionId,{executionId:parsed.data.executionId,attempt:result.snapshot.attempt,afterSequence:result.snapshot.lastSequence});
          reply({ok:true,...result});
        } catch(e) {reply({ok:false,error:{code:e instanceof ApiError?'NOT_FOUND':'SERVICE_UNAVAILABLE'}});} finally {client.commandBusy=false;}
      });
      socket.on('unsubscribe_execution',(id:unknown)=>{if(typeof id==='string') client.subscriptions.delete(id);});
    });
    this.timer=setInterval(()=>{if (!this.polling) this.polling=this.poll().finally(()=>{this.polling=undefined;});},500);this.timer.unref();
  }
  private async poll() {
    for (const [socket,client] of this.clients) {
      if(client.commandBusy || client.polling) continue;
      client.polling=(async()=>{
        const principal=await this.sessions.resolve(socket.request as Request);
        if (!principal || principal.userId!==client.userId) {socket.disconnect(true);return;}
        for(const cursor of client.subscriptions.values()) {
          const result=await this.jobs.replay(client.userId,cursor.executionId,cursor.attempt,cursor.afterSequence);
          if(!socket.connected) break;
          // Disconnect slow clients rather than buffering an unbounded stream.
          if (!socket.conn.transport.writable) {socket.disconnect(true);break;}
          if(!result.replayAvailable) socket.emit('execution_sync',{snapshot:result.snapshot,replayAvailable:false});
          else for(const event of result.events) socket.emit(event.kind,event);
          cursor.attempt=result.snapshot.attempt;cursor.afterSequence=result.snapshot.lastSequence;
        }
      })();
      try {await client.polling;} catch {socket.disconnect(true);} finally {client.polling=undefined;}
    }
  }
  async onModuleDestroy() {
    if(this.timer) clearInterval(this.timer);
    this.io?.disconnectSockets(true);await this.polling;
    if(this.io) await new Promise<void>(resolve=>this.io!.close(()=>resolve()));
  }
}
