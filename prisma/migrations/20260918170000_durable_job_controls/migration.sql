CREATE TYPE "ExecutionFailureCode" AS ENUM ('QUEUE_TIMEOUT', 'JOB_FAILURE');

ALTER TABLE "Execution" ADD COLUMN "queueExpiresAt" TIMESTAMP(3),
  ADD COLUMN "failureCode" "ExecutionFailureCode";
-- Preserve the deadline of legacy rows relative to their original creation.
UPDATE "Execution" SET "queueExpiresAt" = "createdAt" + INTERVAL '2 minutes';
ALTER TABLE "Execution" ALTER COLUMN "queueExpiresAt" SET NOT NULL,
  ALTER COLUMN "queueExpiresAt" SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '2 minutes');

CREATE TABLE "ExecutionRateLimit" (
  "key" CHAR(64) NOT NULL PRIMARY KEY,
  "count" INTEGER NOT NULL DEFAULT 1 CHECK ("count" > 0),
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ExecutionRateLimit_expiresAt_idx" ON "ExecutionRateLimit"("expiresAt");
CREATE INDEX "Execution_userId_mode_createdAt_id_idx" ON "Execution"("userId", "mode", "createdAt", "id");
CREATE INDEX "Execution_state_queueExpiresAt_id_idx" ON "Execution"("state", "queueExpiresAt", "id");
CREATE UNIQUE INDEX "OutboxEvent_executionId_kind_key" ON "OutboxEvent"("executionId", "kind");
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_executionId_fkey"
  FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Execution" ADD CONSTRAINT valid_execution_terminal_fields CHECK (
  (state IN ('QUEUED', 'COMPILING', 'RUNNING') AND verdict IS NULL AND "finishedAt" IS NULL AND "failureCode" IS NULL)
  OR (state = 'FINISHED' AND verdict IS NOT NULL AND verdict NOT IN ('CANCELLED', 'INTERNAL_ERROR') AND "finishedAt" IS NOT NULL AND "failureCode" IS NULL)
  OR (state = 'CANCELLED' AND verdict = 'CANCELLED' AND verdict IS NOT NULL AND "finishedAt" IS NOT NULL AND "failureCode" IS NULL)
  OR (state = 'INTERNAL_ERROR' AND verdict = 'INTERNAL_ERROR' AND verdict IS NOT NULL AND "finishedAt" IS NOT NULL)
);
ALTER TABLE "Execution" ADD CONSTRAINT valid_execution_counters CHECK (attempt >= 0 AND "lastSequence" >= 0);
ALTER TABLE "Execution" ADD CONSTRAINT valid_queue_deadline CHECK ("queueExpiresAt" > "createdAt");

CREATE FUNCTION protect_execution_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'QUEUED' THEN RAISE EXCEPTION 'executions must start queued'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "ProblemVersion" WHERE id = NEW."problemVersionId" AND published) THEN
      RAISE EXCEPTION 'execution version must be published';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW."userId", NEW."problemVersionId", NEW.language, NEW.mode, NEW."sourceCode",
      NEW."payloadHash", NEW."idempotencyKey", NEW."createdAt", NEW."queueExpiresAt") IS DISTINCT FROM
     (OLD.id, OLD."userId", OLD."problemVersionId", OLD.language, OLD.mode, OLD."sourceCode",
      OLD."payloadHash", OLD."idempotencyKey", OLD."createdAt", OLD."queueExpiresAt") THEN
    RAISE EXCEPTION 'execution request and version snapshot are immutable';
  END IF;
  -- Allow an ORM's timestamp-only no-op, but no late rewriting of terminal facts.
  IF OLD.state IN ('FINISHED', 'CANCELLED', 'INTERNAL_ERROR')
      AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'terminal executions are immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('COMPILING', 'CANCELLED', 'INTERNAL_ERROR')) OR
    (OLD.state = 'COMPILING' AND NEW.state IN ('RUNNING', 'FINISHED', 'CANCELLED', 'INTERNAL_ERROR')) OR
    (OLD.state = 'RUNNING' AND NEW.state IN ('FINISHED', 'CANCELLED', 'INTERNAL_ERROR'))
  ) THEN RAISE EXCEPTION 'invalid execution state transition'; END IF;
  IF NEW.attempt < OLD.attempt OR (NEW.attempt = OLD.attempt AND NEW."lastSequence" < OLD."lastSequence") THEN
    RAISE EXCEPTION 'execution attempt and sequence cannot regress';
  END IF;
  IF NEW."failureCode" = 'QUEUE_TIMEOUT' AND NOT (OLD.state = 'QUEUED' AND NEW.state = 'INTERNAL_ERROR') THEN
    RAISE EXCEPTION 'queue timeout requires queued execution';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER valid_execution_lifecycle BEFORE INSERT OR UPDATE ON "Execution"
  FOR EACH ROW EXECUTE FUNCTION protect_execution_lifecycle();
