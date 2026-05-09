import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TimeoutService } from './timeout.service';
import { MerchantTimeoutProcessor, CustomerDecisionTimeoutProcessor, IdempotencyCleanupProcessor } from './timeout.processor';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    RealtimeModule,
    BullModule.registerQueue({ name: 'merchant-timeouts' }),
    BullModule.registerQueue({ name: 'customer-decision-timeouts' }),
    BullModule.registerQueue({ name: 'idempotency-cleanup' }),
  ],
  providers: [TimeoutService, MerchantTimeoutProcessor, CustomerDecisionTimeoutProcessor],
  exports: [TimeoutService],
})
export class TimeoutModule {}
