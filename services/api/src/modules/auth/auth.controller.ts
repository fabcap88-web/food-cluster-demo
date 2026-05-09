import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('/auth/dev')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('/admin')
  admin() {
    return this.authService.devAdminToken();
  }

  @Post('/merchant')
  merchant(@Body() body: { brandSlug: string }) {
    return this.authService.devMerchantToken(body.brandSlug);
  }

  @Post('/customer')
  customer(@Body() body: { phone: string }) {
    return this.authService.devCustomerToken(body.phone);
  }
}
