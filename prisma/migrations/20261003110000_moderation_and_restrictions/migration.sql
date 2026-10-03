ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'MODERATOR' BEFORE 'ADMIN';

CREATE TYPE "ReportReason" AS ENUM ('SPAM', 'HARASSMENT', 'SOLUTION_LEAK', 'OFF_TOPIC', 'OTHER');
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RESOLVED', 'DISMISSED');

ALTER TABLE "User"
  ADD COLUMN "suspendedUntil" TIMESTAMP(3),
  ADD COLUMN "bannedAt" TIMESTAMP(3),
  ADD COLUMN "restrictionReason" TEXT;

ALTER TABLE "User" ADD CONSTRAINT "User_restrictionReason_length_check"
  CHECK ("restrictionReason" IS NULL OR char_length("restrictionReason") BETWEEN 3 AND 500);

CREATE TABLE "ContentReport" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "postId" UUID NOT NULL,
  "reporterId" UUID NOT NULL,
  "reason" "ReportReason" NOT NULL,
  "details" TEXT,
  "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
  "moderatorId" UUID,
  "moderatorNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ContentReport_details_length_check" CHECK ("details" IS NULL OR char_length("details") BETWEEN 3 AND 1000),
  CONSTRAINT "ContentReport_moderatorNote_length_check" CHECK ("moderatorNote" IS NULL OR char_length("moderatorNote") BETWEEN 3 AND 1000),
  CONSTRAINT "ContentReport_resolution_check" CHECK (
    ("status" = 'PENDING' AND "moderatorId" IS NULL AND "resolvedAt" IS NULL) OR
    ("status" <> 'PENDING' AND "resolvedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "ContentReport_postId_reporterId_key" ON "ContentReport"("postId", "reporterId");
CREATE INDEX "ContentReport_status_createdAt_id_idx" ON "ContentReport"("status", "createdAt", "id");
CREATE INDEX "ContentReport_reporterId_createdAt_id_idx" ON "ContentReport"("reporterId", "createdAt", "id");
CREATE INDEX "User_suspendedUntil_idx" ON "User"("suspendedUntil");

ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
