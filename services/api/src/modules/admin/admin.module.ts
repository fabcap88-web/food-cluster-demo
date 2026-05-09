import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { ResolutionService } from './resolution.service';
import { LedgerModule } from '../ledger/ledger.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TimeoutModule } from '../timeouts/timeout.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [LedgerModule, RealtimeModule, TimeoutModule, AuthModule],
  controllers: [AdminController],
  providers: [ResolutionService],
})
export class AdminModule {}
