CREATE TYPE "ProblemInputMode" AS ENUM ('STDIN', 'FILES');

ALTER TABLE "ProblemVersion"
ADD COLUMN "inputMode" "ProblemInputMode" NOT NULL DEFAULT 'STDIN';

CREATE TABLE "TestCaseFile" (
  "testCaseId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  CONSTRAINT "TestCaseFile_pkey" PRIMARY KEY ("testCaseId", "name")
);

ALTER TABLE "TestCaseFile"
ADD CONSTRAINT "TestCaseFile_testCaseId_fkey"
FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TestCaseFile"
ADD CONSTRAINT "safe_test_file_name" CHECK (
  "name" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$'
  AND "name" NOT IN ('Solution.java', 'Solution.class', 'solution.py', 'solution.js')
  AND "name" !~ '\.class$'
),
ADD CONSTRAINT "bounded_test_file_content" CHECK (octet_length("content") <= 262144);

CREATE FUNCTION validate_problem_input_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published AND NOT OLD.published THEN
    IF NEW."inputMode" = 'STDIN' AND EXISTS (
      SELECT 1 FROM "TestCaseFile" f JOIN "TestCase" t ON t.id = f."testCaseId"
      WHERE t."problemVersionId" = NEW.id
    ) THEN
      RAISE EXCEPTION 'stdin problem versions cannot contain test files';
    END IF;
    IF NEW."inputMode" = 'FILES' AND EXISTS (
      SELECT 1 FROM "TestCase" t WHERE t."problemVersionId" = NEW.id
      AND (t.input <> '' OR NOT EXISTS (SELECT 1 FROM "TestCaseFile" f WHERE f."testCaseId" = t.id))
    ) THEN
      RAISE EXCEPTION 'file problem versions require at least one file and empty stdin for every case';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_problem_inputs_before_publish
BEFORE UPDATE OF published ON "ProblemVersion"
FOR EACH ROW EXECUTE FUNCTION validate_problem_input_contract();

CREATE FUNCTION protect_published_test_files() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_id UUID;
BEGIN
  version_id := CASE WHEN TG_OP = 'DELETE' THEN
    (SELECT "problemVersionId" FROM "TestCase" WHERE id = OLD."testCaseId")
  ELSE
    (SELECT "problemVersionId" FROM "TestCase" WHERE id = NEW."testCaseId")
  END;
  IF version_id IS NOT NULL THEN
    PERFORM 1 FROM "ProblemVersion" WHERE id = version_id FOR SHARE;
    IF EXISTS (SELECT 1 FROM "ProblemVersion" WHERE id = version_id AND published) THEN
      RAISE EXCEPTION 'published test files are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER immutable_published_test_files
BEFORE INSERT OR UPDATE OR DELETE ON "TestCaseFile"
FOR EACH ROW EXECUTE FUNCTION protect_published_test_files();
