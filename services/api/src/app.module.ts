import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './common/prisma.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { TimeoutModule } from './modules/timeouts/timeout.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { OrdersModule } from './modules/orders/orders.module';
import { SubOrderModule } from './modules/sub-orders/sub-order.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthModule } from './modules/auth/auth.module';

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be defined');
}

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD || undefined,
      },
      defaultJobOptions: {
        attempts: 3,
      },
    }),
    CatalogModule,
    RealtimeModule,
    TimeoutModule,
    LedgerModule,
    OrdersModule,
    SubOrderModule,
    AdminModule,
  ],
})
export class AppModule {}
