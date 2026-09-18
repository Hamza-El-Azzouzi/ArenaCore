ALTER TYPE "ExecutionFailureCode" ADD VALUE 'LEASE_EXPIRED';
ALTER TYPE "ExecutionFailureCode" ADD VALUE 'JOB_TIMEOUT';
ALTER TYPE "ExecutionFailureCode" ADD VALUE 'CANCELLATION_TIMEOUT';
ALTER TABLE "Execution" ADD COLUMN "cancellationRequestedAt" TIMESTAMP(3);
CREATE INDEX "Execution_state_leaseExpiresAt_idx" ON "Execution"(state,"leaseExpiresAt");
ALTER TABLE "OutboxEvent" ADD COLUMN generation INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "dispatchToken" UUID, ADD COLUMN "dispatchExpiresAt" TIMESTAMP(3),
 ADD COLUMN "nextDispatchAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "dispatchAttempts" INTEGER NOT NULL DEFAULT 0;
DROP INDEX "OutboxEvent_executionId_kind_key";
CREATE UNIQUE INDEX "OutboxEvent_executionId_kind_generation_key" ON "OutboxEvent"("executionId",kind,generation);
CREATE TABLE "ExecutionEvent" (
 id UUID PRIMARY KEY, "executionId" UUID NOT NULL REFERENCES "Execution"(id) ON DELETE CASCADE,
 attempt INTEGER NOT NULL CHECK(attempt >= 0), sequence INTEGER NOT NULL CHECK(sequence > 0),
 kind TEXT NOT NULL CHECK(kind IN ('execution_status','console_output','final_verdict')),
 payload JSONB NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 16384),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("executionId",attempt,sequence));
CREATE INDEX "ExecutionEvent_expiresAt_idx" ON "ExecutionEvent"("expiresAt");
CREATE OR REPLACE FUNCTION protect_execution_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD."cancellationRequestedAt" IS NOT NULL AND NEW."cancellationRequestedAt" IS DISTINCT FROM OLD."cancellationRequestedAt" THEN
    RAISE EXCEPTION 'cancellation request is immutable';
  END IF;
  IF OLD."leaseToken" IS NOT NULL AND NEW."leaseToken" IS NOT NULL
      AND (NEW."leaseToken", NEW.attempt) IS DISTINCT FROM (OLD."leaseToken", OLD.attempt)
      AND NOT (OLD.state IN ('COMPILING','RUNNING') AND OLD."leaseExpiresAt" <= clock_timestamp()
        AND NEW.state='COMPILING' AND NEW.attempt=OLD.attempt+1 AND NEW."leaseToken" <> OLD."leaseToken") THEN
    RAISE EXCEPTION 'lease replacement requires expired authority and a new attempt';
  END IF;
  -- Allow an ORM's timestamp-only no-op, but no late rewriting of terminal facts.
  IF OLD.state IN ('FINISHED', 'CANCELLED', 'INTERNAL_ERROR')
      AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION 'terminal executions are immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state = 'QUEUED' AND NEW.state IN ('COMPILING', 'CANCELLED', 'INTERNAL_ERROR')) OR
    (OLD.state = 'COMPILING' AND NEW.state IN ('RUNNING', 'FINISHED', 'CANCELLED', 'INTERNAL_ERROR')) OR
    (OLD.state = 'RUNNING' AND NEW.state IN ('FINISHED', 'CANCELLED', 'INTERNAL_ERROR')) OR
    (OLD.state = 'RUNNING' AND NEW.state = 'COMPILING' AND OLD."leaseExpiresAt" <= clock_timestamp() AND NEW.attempt = OLD.attempt + 1 AND NEW."leaseToken" IS DISTINCT FROM OLD."leaseToken")
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

ALTER TABLE "Execution" ADD CONSTRAINT valid_execution_lease_pair CHECK (
 ("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL) OR
 ("leaseToken" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL AND state IN ('COMPILING','RUNNING')));
