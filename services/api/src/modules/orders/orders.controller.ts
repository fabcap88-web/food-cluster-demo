import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@Controller('/customer/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('/quote')
  quote(@Body() body: any) {
    return this.ordersService.quote(body);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @Post()
  createOrder(@Body() body: any, @CurrentUser() user: any) {
    return this.ordersService.createOrder({
      ...body,
      customer: {
        id: user.customerId,
        phone: user.phone,
        name: body.customer?.name,
      },
    });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CUSTOMER')
  @Get('/:orderId/tracking')
  tracking(@Param('orderId') orderId: string, @CurrentUser() user: any) {
    return this.ordersService.getTracking(orderId, user.customerId);
  }
}
