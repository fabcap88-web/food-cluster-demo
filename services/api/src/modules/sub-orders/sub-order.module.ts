import { Module } from '@nestjs/common';
import { SubOrderController } from './sub-order.controller';
import { SubOrderService } from './sub-order.service';
import { OrdersModule } from '../orders/orders.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TimeoutModule } from '../timeouts/timeout.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [OrdersModule, RealtimeModule, TimeoutModule, AuthModule],
  controllers: [SubOrderController],
  providers: [SubOrderService],
})
export class SubOrderModule {}
