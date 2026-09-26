CREATE TYPE "CompetitionKind" AS ENUM ('CONTEST', 'TOURNAMENT');

CREATE TABLE "Competition" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" TEXT NOT NULL,
  "kind" "CompetitionKind" NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "rulesMarkdown" TEXT NOT NULL,
  "prizeLabel" TEXT,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Competition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Competition_time_check" CHECK ("endsAt" > "startsAt")
);

CREATE TABLE "CompetitionRound" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "competitionId" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CompetitionRound_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompetitionRound_time_check" CHECK ("endsAt" > "startsAt")
);

CREATE TABLE "CompetitionProblem" (
  "roundId" UUID NOT NULL,
  "problemId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "points" INTEGER NOT NULL DEFAULT 100,
  CONSTRAINT "CompetitionProblem_pkey" PRIMARY KEY ("roundId", "problemId"),
  CONSTRAINT "CompetitionProblem_points_check" CHECK ("points" > 0)
);

CREATE TABLE "CompetitionRegistration" (
  "competitionId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompetitionRegistration_pkey" PRIMARY KEY ("competitionId", "userId")
);

CREATE UNIQUE INDEX "Competition_slug_key" ON "Competition"("slug");
CREATE INDEX "Competition_kind_published_startsAt_idx" ON "Competition"("kind", "published", "startsAt");
CREATE UNIQUE INDEX "CompetitionRound_competitionId_ordinal_key" ON "CompetitionRound"("competitionId", "ordinal");
CREATE INDEX "CompetitionRound_competitionId_startsAt_idx" ON "CompetitionRound"("competitionId", "startsAt");
CREATE UNIQUE INDEX "CompetitionProblem_roundId_ordinal_key" ON "CompetitionProblem"("roundId", "ordinal");
CREATE INDEX "CompetitionProblem_problemId_idx" ON "CompetitionProblem"("problemId");
CREATE INDEX "CompetitionRegistration_userId_joinedAt_idx" ON "CompetitionRegistration"("userId", "joinedAt");

ALTER TABLE "CompetitionRound" ADD CONSTRAINT "CompetitionRound_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitionProblem" ADD CONSTRAINT "CompetitionProblem_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "CompetitionRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitionProblem" ADD CONSTRAINT "CompetitionProblem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompetitionRegistration" ADD CONSTRAINT "CompetitionRegistration_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompetitionRegistration" ADD CONSTRAINT "CompetitionRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
