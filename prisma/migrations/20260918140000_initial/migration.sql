-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('java', 'python', 'javascript');

-- CreateEnum
CREATE TYPE "ExecutionMode" AS ENUM ('RUN', 'SUBMIT');

-- CreateEnum
CREATE TYPE "ExecutionState" AS ENUM ('QUEUED', 'COMPILING', 'RUNNING', 'FINISHED', 'CANCELLED', 'INTERNAL_ERROR');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('ACCEPTED', 'WRONG_ANSWER', 'COMPILATION_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'CANCELLED', 'INTERNAL_ERROR');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'HIDDEN');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "csrfTokenHash" CHAR(64) NOT NULL,
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "currentVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProblemVersion" (
    "id" UUID NOT NULL,
    "problemId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "difficulty" "Difficulty" NOT NULL,
    "tags" TEXT[],
    "statementMarkdown" TEXT NOT NULL,
    "constraints" TEXT[],
    "timeMs" INTEGER NOT NULL,
    "memoryKiB" INTEGER NOT NULL,
    "templates" JSONB NOT NULL,
    "comparator" TEXT NOT NULL DEFAULT 'EXACT_NEWLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCase" (
    "id" UUID NOT NULL,
    "problemVersionId" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "visibility" "Visibility" NOT NULL,
    "input" TEXT NOT NULL,
    "expectedOutput" TEXT NOT NULL,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "problemVersionId" UUID NOT NULL,
    "language" "Language" NOT NULL,
    "mode" "ExecutionMode" NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "payloadHash" CHAR(64) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "state" "ExecutionState" NOT NULL DEFAULT 'QUEUED',
    "verdict" "Verdict",
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMP(3),
    "runtimeImage" TEXT,
    "runtimeMs" INTEGER,
    "memoryKiB" INTEGER,
    "publicResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "executionId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "targetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_issuer_subject_key" ON "User"("issuer", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_slug_key" ON "Problem"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_currentVersionId_key" ON "Problem"("currentVersionId");

-- CreateIndex
CREATE INDEX "ProblemVersion_published_problemId_idx" ON "ProblemVersion"("published", "problemId");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemVersion_problemId_number_key" ON "ProblemVersion"("problemId", "number");

-- CreateIndex
CREATE INDEX "TestCase_problemVersionId_visibility_idx" ON "TestCase"("problemVersionId", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "TestCase_problemVersionId_ordinal_key" ON "TestCase"("problemVersionId", "ordinal");

-- CreateIndex
CREATE INDEX "Execution_userId_state_idx" ON "Execution"("userId", "state");

-- CreateIndex
CREATE INDEX "Execution_state_createdAt_idx" ON "Execution"("state", "createdAt");

-- CreateIndex
CREATE INDEX "Execution_userId_mode_id_idx" ON "Execution"("userId", "mode", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_userId_idempotencyKey_key" ON "Execution"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "ProblemVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProblemVersion" ADD CONSTRAINT "ProblemVersion_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Published versions and their test suites are immutable. Changes require a new version.
CREATE FUNCTION protect_published_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published THEN
    RAISE EXCEPTION 'published problem versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_published_version BEFORE UPDATE OR DELETE ON "ProblemVersion"
  FOR EACH ROW EXECUTE FUNCTION protect_published_version();

CREATE FUNCTION protect_published_tests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM 1 FROM "ProblemVersion" WHERE id = OLD."problemVersionId" AND published FOR SHARE;
    IF FOUND THEN RAISE EXCEPTION 'published test suites are immutable'; END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    -- Lock even unpublished parent versions to serialize edits with publication.
    PERFORM 1 FROM "ProblemVersion" WHERE id = NEW."problemVersionId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM "ProblemVersion" WHERE id = NEW."problemVersionId" AND published) THEN
      RAISE EXCEPTION 'published test suites are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_published_tests BEFORE INSERT OR UPDATE OR DELETE ON "TestCase"
  FOR EACH ROW EXECUTE FUNCTION protect_published_tests();

CREATE FUNCTION validate_current_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."currentVersionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ProblemVersion" WHERE id = NEW."currentVersionId" AND "problemId" = NEW.id AND published
  ) THEN RAISE EXCEPTION 'current version must be published and belong to this problem'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER valid_current_version BEFORE INSERT OR UPDATE ON "Problem"
  FOR EACH ROW EXECUTE FUNCTION validate_current_version();

ALTER TABLE "ProblemVersion" ADD CONSTRAINT positive_problem_limits CHECK ("timeMs" > 0 AND "memoryKiB" > 0 AND number > 0);
ALTER TABLE "TestCase" ADD CONSTRAINT nonnegative_test_ordinal CHECK (ordinal >= 0);
ALTER TABLE "Execution" ADD CONSTRAINT source_byte_cap CHECK (octet_length("sourceCode") BETWEEN 1 AND 65536);
ALTER TABLE "Execution" ADD CONSTRAINT nonnegative_metrics CHECK (("runtimeMs" IS NULL OR "runtimeMs" >= 0) AND ("memoryKiB" IS NULL OR "memoryKiB" >= 0));
ALTER TABLE "Execution" ADD CONSTRAINT private_submit_results CHECK (mode = 'RUN' OR "publicResults" IS NULL);
