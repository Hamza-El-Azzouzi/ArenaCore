CREATE FUNCTION create_execution_result_notification(
  execution_id UUID,
  expected_attempt INTEGER,
  expected_lease_token UUID,
  result_verdict TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF result_verdict NOT IN (
    'ACCEPTED',
    'WRONG_ANSWER',
    'TIME_LIMIT_EXCEEDED',
    'MEMORY_LIMIT_EXCEEDED',
    'RUNTIME_ERROR',
    'COMPILATION_ERROR',
    'OUTPUT_LIMIT_EXCEEDED',
    'INTERNAL_ERROR'
  ) THEN
    RAISE EXCEPTION 'invalid execution notification verdict';
  END IF;

  INSERT INTO public."Notification" (
    id,
    "userId",
    kind,
    title,
    body,
    href,
    "dedupeKey",
    "createdAt"
  )
  SELECT
    gen_random_uuid(),
    e."userId",
    'EXECUTION_RESULT',
    'Submission judged',
    pv.title || ': ' || lower(replace(result_verdict, '_', ' ')) || '.',
    '/problems/' || p.slug || '?tab=submissions',
    'execution:' || e.id::text || ':result',
    CURRENT_TIMESTAMP
  FROM public."Execution" e
  JOIN public."User" u ON u.id = e."userId"
  JOIN public."ProblemVersion" pv ON pv.id = e."problemVersionId"
  JOIN public."Problem" p ON p.id = pv."problemId"
  WHERE e.id = execution_id
    AND e.mode = 'SUBMIT'
    AND e.state IN ('COMPILING', 'RUNNING')
    AND e.attempt = expected_attempt
    AND e."leaseToken" = expected_lease_token
    AND u."productNotifications"
  ON CONFLICT ("userId", "dedupeKey") DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION create_execution_result_notification(UUID, INTEGER, UUID, TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'arenacore_worker') THEN
    GRANT EXECUTE ON FUNCTION create_execution_result_notification(UUID, INTEGER, UUID, TEXT)
      TO arenacore_worker;
  END IF;
END;
$$;
