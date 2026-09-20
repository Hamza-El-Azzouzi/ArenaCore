import { PrismaClient } from '@prisma/client';
import { seed } from './sample-seed';

const db=new PrismaClient();
void seed(db)
  .then(result=>console.log(result==='created'?'SAMPLE_SEED_CREATED':'SAMPLE_SEED_VERIFIED'))
  .catch(()=>{console.error('SAMPLE_SEED_FAILED');process.exitCode=1;})
  .finally(()=>db.$disconnect());
