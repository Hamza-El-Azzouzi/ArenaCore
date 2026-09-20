import { PrismaClient } from '@prisma/client';
import { sampleProblemId, sampleVersionId, seed } from '../apps/api/src/database/sample-seed';
export { sampleProblemId, sampleVersionId, seed };
if (require.main === module) {
  const db = new PrismaClient();
  seed(db).then(() => console.log('Sample problem seeded.')).catch(() => {console.error('Seed failed.'); process.exitCode = 1;}).finally(() => db.$disconnect());
}
