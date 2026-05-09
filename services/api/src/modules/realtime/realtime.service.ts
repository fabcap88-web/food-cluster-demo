import { Injectable } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
@Injectable()
export class RealtimeService {
 constructor(private readonly gateway: RealtimeGateway){}
 emitToAdmins(event:string,payload:unknown){ this.gateway.emitToAdmins(event,payload);}
 emitToMerchant(brandId:string,event:string,payload:unknown){ this.gateway.emitToMerchant(brandId,event,payload);}
 emitToCustomer(customerId:string,event:string,payload:unknown){ this.gateway.emitToCustomer(customerId,event,payload);}
}
