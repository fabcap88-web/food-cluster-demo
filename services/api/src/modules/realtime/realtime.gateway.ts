import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
@WebSocketGateway({ cors: { origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'] }})
export class RealtimeGateway implements OnGatewayInit {
 @WebSocketServer() server!: Server;
 constructor(private readonly jwtService: JwtService){}
 afterInit(server: Server){ server.use((socket,next)=>{ try{ const token=socket.handshake.auth?.token||socket.handshake.headers.authorization?.toString().replace('Bearer ',''); if(!token) return next(new Error('Unauthorized')); (socket as any).authPayload=this.jwtService.verify(token); next(); } catch { next(new Error('Unauthorized')); }});}
 @SubscribeMessage('join_admin_room') joinAdminRoom(@ConnectedSocket() socket: Socket){ const payload=(socket as any).authPayload; if(!payload||payload.role!=='ADMIN') return {ok:false}; socket.join('admins'); return {ok:true};}
 @SubscribeMessage('join_merchant_room') joinMerchantRoom(@ConnectedSocket() socket: Socket,@MessageBody() body:{brandId:string}){ const payload=(socket as any).authPayload; if(!payload||payload.role!=='MERCHANT'||payload.brandId!==body.brandId) return {ok:false}; socket.join(`merchant:${body.brandId}`); return {ok:true};}
 @SubscribeMessage('join_customer_room') joinCustomerRoom(@ConnectedSocket() socket: Socket,@MessageBody() body:{customerId:string}){ const payload=(socket as any).authPayload; if(!payload||payload.role!=='CUSTOMER'||payload.customerId!==body.customerId) return {ok:false}; socket.join(`customer:${body.customerId}`); return {ok:true};}
 emitToAdmins(event:string,payload:unknown){ this.server.to('admins').emit(event,payload);}
 emitToMerchant(brandId:string,event:string,payload:unknown){ this.server.to(`merchant:${brandId}`).emit(event,payload);}
 emitToCustomer(customerId:string,event:string,payload:unknown){ this.server.to(`customer:${customerId}`).emit(event,payload);}
}
