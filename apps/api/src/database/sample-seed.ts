import { PrismaClient } from '@prisma/client';

export const sampleProblemId = '00000000-0000-4000-8000-000000000001';
export const sampleVersionId = '00000000-0000-4000-8000-000000000002';
const cases = [
  {ordinal:0,visibility:'PUBLIC' as const,input:'2 3\n',expectedOutput:'5\n'},
  {ordinal:1,visibility:'PUBLIC' as const,input:'-2 8\n',expectedOutput:'6\n'},
  {ordinal:2,visibility:'HIDDEN' as const,input:'1000000000 1000000000\n',expectedOutput:'2000000000\n'},
];

export async function seed(db:PrismaClient) {
  return db.$transaction(async tx=>{
    const existing=await tx.problem.findUnique({where:{slug:'sum-two-numbers'},include:{versions:{where:{id:sampleVersionId},include:{testCases:{orderBy:{ordinal:'asc'}}}}}});
    if(existing){
      const version=existing.versions[0];
      const exact=existing.id===sampleProblemId&&existing.currentVersionId===sampleVersionId&&version?.published===true&&version.comparator==='EXACT_NEWLINE'&&version.timeMs===2000&&version.memoryKiB===262144&&version.testCases.length===cases.length&&version.testCases.every((test,index)=>{
        const expected=cases[index];return !!expected&&test.ordinal===expected.ordinal&&test.visibility===expected.visibility&&test.input===expected.input&&test.expectedOutput===expected.expectedOutput;
      });
      if(!exact)throw new Error('SAMPLE_SEED_CONFLICT');
      return 'verified' as const;
    }
    await tx.problem.create({data:{id:sampleProblemId,slug:'sum-two-numbers'}});
    await tx.problemVersion.create({data:{
      id:sampleVersionId,problemId:sampleProblemId,number:1,title:'Sum Two Numbers',difficulty:'EASY',tags:['math','stdin'],
      statementMarkdown:'Read two integers from standard input and print their sum followed by a newline.',
      constraints:['-1000000000 <= a, b <= 1000000000'],timeMs:2000,memoryKiB:262144,
      templates:{
        java:'import java.util.Scanner;\npublic class Solution {\n  public static void main(String[] args) {\n    Scanner scanner = new Scanner(System.in);\n    long a = scanner.nextLong();\n    long b = scanner.nextLong();\n    // Print the sum.\n  }\n}\n',
        python:'import sys\na, b = map(int, sys.stdin.read().split())\n# Print the sum.\n',
        javascript:"const fs = require('node:fs');\nconst [a, b] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\n// Print the sum.\n",
      },
    }});
    await tx.testCase.createMany({data:cases.map(test=>({problemVersionId:sampleVersionId,...test}))});
    await tx.problemVersion.update({where:{id:sampleVersionId},data:{published:true}});
    await tx.problem.update({where:{id:sampleProblemId},data:{currentVersionId:sampleVersionId}});
    return 'created' as const;
  });
}
