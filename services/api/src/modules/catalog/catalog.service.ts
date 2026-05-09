import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
@Injectable()
export class CatalogService {
 constructor(private readonly prisma: PrismaService){}
 async getCatalog(){
  const court=await this.prisma.virtualCourt.findFirst({where:{isActive:true}});
  const products=await this.prisma.product.findMany({where:{status:'ACTIVE',brand:{status:'ACTIVE'}},include:{brand:true},orderBy:[{category:'asc'},{sortOrder:'asc'},{name:'asc'}]});
  return {categories:Array.from(new Set(products.map(p=>p.category))),products:products.map(p=>({id:p.id,brandId:p.brandId,brandName:p.brand.name,name:p.name,slug:p.slug,description:p.description??undefined,category:p.category,priceCents:p.priceCents,imageUrl:p.imageUrl??undefined,prepMinutes:p.prepMinutes??p.brand.defaultPrepMinutes})),freeDeliveryThresholdCents:court?.freeDeliveryThresholdCents??2500};
 }
}
