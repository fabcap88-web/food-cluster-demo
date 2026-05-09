import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { SubOrderService, MerchantStatusUpdate } from './sub-order.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MERCHANT')
@Controller('/merchant')
export class SubOrderController {
  constructor(private readonly subOrderService: SubOrderService) {}

  @Get('/orders')
  getMerchantOrders(@CurrentUser() user: any) {
    return this.subOrderService.getMerchantOrders(user.brandId);
  }

  @Patch('/sub-orders/:subOrderId/accept')
  accept(@Param('subOrderId') subOrderId: string, @Body() body: { prepEtaMinutes: number }, @CurrentUser() user: any) {
    return this.subOrderService.acceptSubOrder(subOrderId, user.brandId, body.prepEtaMinutes);
  }

  @Patch('/sub-orders/:subOrderId/reject')
  reject(@Param('subOrderId') subOrderId: string, @Body() body: { reason: string }, @CurrentUser() user: any) {
    return this.subOrderService.rejectSubOrder(subOrderId, user.brandId, body.reason);
  }

  @Patch('/sub-orders/:subOrderId/status')
  status(@Param('subOrderId') subOrderId: string, @Body() body: { status: MerchantStatusUpdate }, @CurrentUser() user: any) {
    return this.subOrderService.updateStatus(subOrderId, user.brandId, body.status);
  }
}
