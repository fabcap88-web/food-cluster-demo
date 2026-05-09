import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
@Processor('merchant-timeouts')
export class MerchantTimeoutProcessor extends WorkerHost {
 constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeService){ super(); }
 async process(job: Job<{subOrderId:string}>){ if(job.name!=='merchant-acceptance-timeout') return; const {subOrderId}=job.data; const result=await this.prisma.$transaction(async(tx)=>{ const subOrder=await tx.subOrder.findUnique({where:{id:subOrderId},include:{masterOrder:true,brand:true}}); if(!subOrder||subOrder.status!=='PENDING') return null; await tx.subOrder.update({where:{id:subOrderId},data:{status:'PENDING_TIMEOUT',rejectedReason:'Merchant did not respond in time'}}); await tx.masterOrder.update({where:{id:subOrder.masterOrderId},data:{status:'RESOLUTION_REQUIRED'}}); await tx.adminAuditLog.create({data:{action:'MERCHANT_TIMEOUT',entityType:'SubOrder',entityId:subOrderId,metadata:{masterOrderId:subOrder.masterOrderId,brandId:subOrder.brandId}}}); return {masterOrderId:subOrder.masterOrderId,brandId:subOrder.brandId,brandName:subOrder.brand.name};}); if(result) this.realtime.emitToAdmins('MERCHANT_TIMEOUT',result);}
}
@Processor('customer-decision-timeouts')
export class CustomerDecisionTimeoutProcessor extends WorkerHost {
 constructor(private readonly prisma: PrismaService, private readonly realtime: RealtimeService){ super(); }
 async process(job: Job<{masterOrderId:string}>){ if(job.name!=='customer-decision-timeout') return; const {masterOrderId}=job.data; const result=await this.prisma.$transaction(async(tx)=>{ const order=await tx.masterOrder.findUnique({where:{id:masterOrderId}}); if(!order||order.status!=='CUSTOMER_DECISION_REQUIRED') return null; await tx.masterOrder.update({where:{id:masterOrderId},data:{status:'RESOLUTION_REQUIRED'}}); await tx.adminAuditLog.create({data:{action:'CUSTOMER_DECISION_TIMEOUT',entityType:'MasterOrder',entityId:masterOrderId,metadata:{}}}); return {masterOrderId};}); if(result) this.realtime.emitToAdmins('CUSTOMER_DECISION_TIMEOUT',result);}
}


@Processor('idempotency-cleanup')
export class IdempotencyCleanupProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job) {
    if (job.name !== 'idempotency-cleanup') return;

    const cutoff = new Date(Date.now() - 5 * 60 * 1000);

    await this.prisma.idempotencyKey.updateMany({
      where: {
        status: 'PROCESSING',
        createdAt: { lt: cutoff },
      },
      data: { status: 'FAILED' },
    });
  }
}
