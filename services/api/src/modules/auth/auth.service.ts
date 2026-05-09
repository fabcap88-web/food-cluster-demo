import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  devAdminToken() {
    return {
      accessToken: this.jwtService.sign({ role: 'ADMIN', actorId: 'dev-admin' }),
    };
  }

  async devMerchantToken(brandSlug: string) {
    const brand = await this.prisma.brand.findUnique({ where: { slug: brandSlug } });
    if (!brand) throw new NotFoundException('Brand not found');

    return {
      accessToken: this.jwtService.sign({
        role: 'MERCHANT',
        brandId: brand.id,
        brandSlug: brand.slug,
      }),
      brandId: brand.id,
    };
  }

  async devCustomerToken(phone: string) {
    const customer = await this.prisma.customer.upsert({
      where: { phone },
      update: {},
      create: { phone },
    });

    return {
      accessToken: this.jwtService.sign({
        role: 'CUSTOMER',
        customerId: customer.id,
        phone: customer.phone,
      }),
      customerId: customer.id,
    };
  }
}
