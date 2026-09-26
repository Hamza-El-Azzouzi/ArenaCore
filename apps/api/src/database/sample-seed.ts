import { Prisma, PrismaClient } from '@prisma/client';

export const sampleProblemId = '00000000-0000-4000-8000-000000000001';
export const sampleVersionId = '00000000-0000-4000-8000-000000000002';
const contestId = '00000000-0000-4000-8000-000000000010';
const contestRoundId = '00000000-0000-4000-8000-000000000011';
const tournamentId = '00000000-0000-4000-8000-000000000020';
const tournamentRoundId = '00000000-0000-4000-8000-000000000021';
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
      await seedCompetitions(tx);
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
    await seedCompetitions(tx);
    return 'created' as const;
  });
}

async function seedCompetitions(tx: Prisma.TransactionClient) {
  const events=[
    {id:contestId,roundId:contestRoundId,slug:'weekend-sprint',kind:'CONTEST' as const,title:'Weekend Sprint',description:'A focused timed contest for practicing speed and accuracy.',rulesMarkdown:'Solve the published problems during the event. Highest score wins; ties use the lowest penalty.',prizeLabel:'1,000 XP',startsAt:new Date('2026-09-27T18:00:00Z'),endsAt:new Date('2026-09-27T20:00:00Z'),roundTitle:'Main round'},
    {id:tournamentId,roundId:tournamentRoundId,slug:'arena-open',kind:'TOURNAMENT' as const,title:'Arena Open',description:'A multi-round tournament that rewards consistent problem solving.',rulesMarkdown:'Register before the final round ends. Scores come from accepted submissions during active tournament rounds.',prizeLabel:'5,000 XP',startsAt:new Date('2026-10-01T18:00:00Z'),endsAt:new Date('2026-10-08T20:00:00Z'),roundTitle:'Qualifier'},
  ];
  for(const event of events){
    await tx.competition.upsert({where:{slug:event.slug},create:{id:event.id,slug:event.slug,kind:event.kind,title:event.title,description:event.description,rulesMarkdown:event.rulesMarkdown,prizeLabel:event.prizeLabel,startsAt:event.startsAt,endsAt:event.endsAt,published:true},update:{title:event.title,description:event.description,rulesMarkdown:event.rulesMarkdown,prizeLabel:event.prizeLabel,published:true}});
    await tx.competitionRound.upsert({where:{competitionId_ordinal:{competitionId:event.id,ordinal:1}},create:{id:event.roundId,competitionId:event.id,title:event.roundTitle,ordinal:1,startsAt:event.startsAt,endsAt:event.endsAt},update:{title:event.roundTitle}});
    await tx.competitionProblem.upsert({where:{roundId_problemId:{roundId:event.roundId,problemId:sampleProblemId}},create:{roundId:event.roundId,problemId:sampleProblemId,ordinal:1,points:100},update:{ordinal:1,points:100}});
  }
}
