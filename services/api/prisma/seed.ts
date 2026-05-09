import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
const prisma = new PrismaClient();
function assertSafeSeedEnvironment(){ if(process.env.NODE_ENV==='production') throw new Error('Refusing to run seed in production');}
async function main(){
 assertSafeSeedEnvironment();
 await prisma.adminAuditLog.deleteMany();
  await prisma.ledgerEntry.deleteMany(); await prisma.creditEntry.deleteMany(); await prisma.deliveryTask.deleteMany(); await prisma.orderItem.deleteMany(); await prisma.subOrder.deleteMany(); await prisma.masterOrder.deleteMany(); await prisma.idempotencyKey.deleteMany(); await prisma.address.deleteMany(); await prisma.customer.deleteMany(); await prisma.product.deleteMany(); await prisma.brandInCourt.deleteMany(); await prisma.virtualCourt.deleteMany(); await prisma.merchantUser.deleteMany(); await prisma.brand.deleteMany();
 const court=await prisma.virtualCourt.create({data:{name:'Food Cluster',slug:'food-cluster',tagline:'Ordina da più brand. Una sola consegna.',deliveryFeeCents:200,freeDeliveryThresholdCents:2500}});
 const burgeri=await prisma.brand.create({data:{name:'Burgerì',slug:'burgeri',description:'Smash burger e comfort food.',defaultPrepMinutes:15}});
 const toastiamo=await prisma.brand.create({data:{name:'Toastiamo',slug:'toastiamo',description:'Toast, sandwich e lunch veloce.',defaultPrepMinutes:10}});
 const sticky=await prisma.brand.create({data:{name:'Sticky Sticks',slug:'sticky-sticks',description:'Dessert on stick, waffle e dolci.',defaultPrepMinutes:8}});
 await prisma.brandInCourt.createMany({data:[{courtId:court.id,brandId:burgeri.id},{courtId:court.id,brandId:toastiamo.id},{courtId:court.id,brandId:sticky.id}]});
 await prisma.product.createMany({data:[
  {brandId:burgeri.id,name:'Smash Burger',slug:'smash-burger',description:'Doppio smash burger con cheddar.',category:'Burger',priceCents:1090,prepMinutes:15,sortOrder:1},
  {brandId:burgeri.id,name:'Cheeseburger Classic',slug:'cheeseburger-classic',description:'Burger classico.',category:'Burger',priceCents:890,prepMinutes:12,sortOrder:2},
  {brandId:toastiamo.id,name:'Club Sandwich',slug:'club-sandwich',description:'Toast triplo.',category:'Toast',priceCents:850,prepMinutes:10,sortOrder:1},
  {brandId:toastiamo.id,name:'Coca-Cola',slug:'coca-cola',description:'Lattina.',category:'Drinks',priceCents:250,prepMinutes:1,sortOrder:3},
  {brandId:sticky.id,name:'Waffle Stick',slug:'waffle-stick',description:'Waffle su stecco.',category:'Dessert',priceCents:550,prepMinutes:8,sortOrder:1},
  {brandId:sticky.id,name:'Cheesecake Stick',slug:'cheesecake-stick',description:'Cheesecake frozen.',category:'Dessert',priceCents:590,prepMinutes:5,sortOrder:2}
 ]});
 console.log('Seed completed.');
}
main().finally(async()=>prisma.$disconnect());
