import { Controller, Get, UseGuards } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { Roles } from '../auth/auth.decorators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
@Controller('/admin/ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Get('/current')
  getCurrentLedger() {
    return this.ledgerService.getCurrentLedger();
  }
}
