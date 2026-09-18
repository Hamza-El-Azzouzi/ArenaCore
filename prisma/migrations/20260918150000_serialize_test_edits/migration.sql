-- Also lock unpublished parent versions during delete/reparent, so publication
-- cannot race a test edit. Keep the initial migration unchanged after application.
CREATE OR REPLACE FUNCTION protect_published_tests() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM 1 FROM "ProblemVersion" WHERE id = OLD."problemVersionId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM "ProblemVersion" WHERE id = OLD."problemVersionId" AND published) THEN
      RAISE EXCEPTION 'published test suites are immutable';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM 1 FROM "ProblemVersion" WHERE id = NEW."problemVersionId" FOR SHARE;
    IF EXISTS (SELECT 1 FROM "ProblemVersion" WHERE id = NEW."problemVersionId" AND published) THEN
      RAISE EXCEPTION 'published test suites are immutable';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
