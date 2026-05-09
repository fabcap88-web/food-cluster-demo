# Food Cluster MVP

Closed-network multi-brand delivery orchestration platform.

## Stack

- Next.js customer / merchant / admin web apps
- NestJS API
- PostgreSQL + Prisma
- Redis + BullMQ
- Socket.io realtime

## Local setup

```bash
pnpm install
cd services/api
cp .env.example .env
cd ../..
docker compose up -d
pnpm db:generate
pnpm db:push
pnpm db:seed
pnpm dev
```

Customer app: http://localhost:3000  
Merchant app: http://localhost:3001  
Admin app: http://localhost:3002  
API: http://localhost:4000

## Dev merchant users

Password for all: `test1234`

- burgeri@test.com
- toastiamo@test.com
- sticky@test.com

## Current status

This repo is a scaffold upgraded with Batch A build/coherence fixes:

- pinned dependencies
- Nest CLI config
- global PrismaModule
- ConfigModule + JWT hard fail
- Redis/Postgres docker healthchecks
- frontend env examples
- shared-types build package
- seed protection + test merchant users

Core order modules are still the next milestone:

- OrdersModule
- SubOrdersModule
- LedgerModule
- Admin ResolutionModule


## Dev auth quickstart

Create a customer token before calling `POST /customer/orders`:

```bash
curl -X POST http://localhost:4000/auth/dev/customer \
  -H "Content-Type: application/json" \
  -d '{"phone":"3331234567"}'
```

Then call checkout with:

```bash
Authorization: Bearer <accessToken>
```

`customer.phone` is no longer trusted from the request body; it is derived from the JWT.


## Vertical slice demo flow

1. Start infra and apps:

```bash
docker compose up -d
pnpm install
cd services/api && cp .env.example .env && cd ../..
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

2. Open:
- Customer: http://localhost:3000
- Merchant: http://localhost:3001
- Admin: http://localhost:3002

3. Customer:
- login with phone `3331234567`
- add products from multiple brands
- checkout cash

4. Merchant:
- login separately as `burgeri`, `toastiamo`, or `sticky-sticks`
- accept/reject/update status

5. Admin:
- login
- monitor live orders
- continue partial / cancel all
- check ledger balance

Known MVP shortcuts:
- dev auth endpoints only
- no real OTP/SMS
- no real payment gateway
- no production-grade frontend polish
