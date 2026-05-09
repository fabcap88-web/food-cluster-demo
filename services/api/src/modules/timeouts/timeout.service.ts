import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class TimeoutService {
  constructor(
    @InjectQueue('merchant-timeouts')
    private readonly merchantTimeoutQueue: Queue,

    @InjectQueue('customer-decision-timeouts')
    private readonly customerDecisionQueue: Queue,

    @InjectQueue('idempotency-cleanup')
    private readonly idempotencyCleanupQueue: Queue,
  ) {}

  async scheduleMerchantAcceptanceTimeout(subOrderId: string) {
    await this.merchantTimeoutQueue.add(
      'merchant-acceptance-timeout',
      { subOrderId },
      {
        delay: 2 * 60 * 1000,
        jobId: `merchant-timeout:${subOrderId}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async cancelMerchantTimeout(subOrderId: string) {
    const job = await this.merchantTimeoutQueue.getJob(`merchant-timeout:${subOrderId}`);
    if (job) await job.remove();
  }

  async scheduleCustomerDecisionTimeout(masterOrderId: string) {
    await this.customerDecisionQueue.add(
      'customer-decision-timeout',
      { masterOrderId },
      {
        delay: 2 * 60 * 1000,
        jobId: `customer-decision-timeout:${masterOrderId}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async cancelCustomerDecisionTimeout(masterOrderId: string) {
    const job = await this.customerDecisionQueue.getJob(`customer-decision-timeout:${masterOrderId}`);
    if (job) await job.remove();
  }

  async scheduleIdempotencyCleanup() {
    await this.idempotencyCleanupQueue.add(
      'idempotency-cleanup',
      {},
      {
        repeat: { every: 60 * 1000 },
        jobId: 'idempotency-cleanup-recurring',
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
}
