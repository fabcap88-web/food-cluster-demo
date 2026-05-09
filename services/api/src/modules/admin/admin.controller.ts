import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ResolutionService } from './resolution.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('/admin')
export class AdminController {
  constructor(private readonly resolution: ResolutionService) {}

  @Get('/orders/live')
  liveOrders() {
    return this.resolution.liveOrders();
  }

  @Post('/orders/:orderId/cancel-all')
  cancelAll(@Param('orderId') orderId: string, @CurrentUser() user: any) {
    return this.resolution.cancelAll(orderId, user.actorId);
  }

  @Post('/orders/:orderId/continue-partial')
  continuePartial(@Param('orderId') orderId: string, @CurrentUser() user: any) {
    return this.resolution.continuePartial(orderId, user.actorId);
  }
}
