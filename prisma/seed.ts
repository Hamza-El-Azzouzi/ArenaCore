import { PrismaClient } from '@prisma/client';
export const sampleProblemId = '00000000-0000-4000-8000-000000000001';
export const sampleVersionId = '00000000-0000-4000-8000-000000000002';

export async function seed(db: PrismaClient) {
  await db.$transaction(async tx => {
    const existing = await tx.problem.findUnique({where: {slug: 'sum-two-numbers'}});
    if (existing) return;
    await tx.problem.create({data: {id: sampleProblemId, slug: 'sum-two-numbers'}});
    await tx.problemVersion.create({data: {
      id: sampleVersionId, problemId: sampleProblemId, number: 1,
      title: 'Sum Two Numbers', difficulty: 'EASY', tags: ['math', 'stdin'],
      statementMarkdown: 'Read two integers from standard input and print their sum followed by a newline.',
      constraints: ['-1000000000 <= a, b <= 1000000000'], timeMs: 2000, memoryKiB: 262144,
      templates: {
        java: 'import java.util.Scanner;\npublic class Solution {\n  public static void main(String[] args) {\n    Scanner scanner = new Scanner(System.in);\n    long a = scanner.nextLong();\n    long b = scanner.nextLong();\n    // Print the sum.\n  }\n}\n',
        python: 'import sys\na, b = map(int, sys.stdin.read().split())\n# Print the sum.\n',
        javascript: "const fs = require('node:fs');\nconst [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\n// Print the sum.\n",
      },
    }});
    await tx.testCase.createMany({data: [
      {problemVersionId: sampleVersionId, ordinal: 0, visibility: 'PUBLIC', input: '2 3\n', expectedOutput: '5\n'},
      {problemVersionId: sampleVersionId, ordinal: 1, visibility: 'PUBLIC', input: '-2 8\n', expectedOutput: '6\n'},
      {problemVersionId: sampleVersionId, ordinal: 2, visibility: 'HIDDEN', input: '1000000000 1000000000\n', expectedOutput: '2000000000\n'},
    ]});
    await tx.problemVersion.update({where: {id: sampleVersionId}, data: {published: true}});
    await tx.problem.update({where: {id: sampleProblemId}, data: {currentVersionId: sampleVersionId}});
  });
}
if (require.main === module) {
  const db = new PrismaClient();
  seed(db).then(() => console.log('Sample problem seeded.')).catch(() => {console.error('Seed failed.'); process.exitCode = 1;}).finally(() => db.$disconnect());
}
