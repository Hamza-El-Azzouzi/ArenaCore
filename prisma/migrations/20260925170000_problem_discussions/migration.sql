CREATE TYPE "DiscussionStatus" AS ENUM ('VISIBLE', 'HIDDEN', 'DELETED');

CREATE TABLE "DiscussionPost" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "problemId" UUID NOT NULL,
  "authorId" UUID NOT NULL,
  "parentId" UUID,
  "title" TEXT,
  "body" TEXT NOT NULL,
  "status" "DiscussionStatus" NOT NULL DEFAULT 'VISIBLE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscussionPost_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DiscussionPost_shape" CHECK (
    ("parentId" IS NULL AND "title" IS NOT NULL AND char_length("title") BETWEEN 5 AND 120) OR
    ("parentId" IS NOT NULL AND "title" IS NULL)
  ),
  CONSTRAINT "DiscussionPost_body_bounds" CHECK (char_length("body") BETWEEN 1 AND 4000),
  CONSTRAINT "DiscussionPost_not_self_parent" CHECK ("parentId" IS NULL OR "parentId" <> "id")
);

CREATE TABLE "DiscussionLike" (
  "postId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DiscussionLike_pkey" PRIMARY KEY ("postId", "userId")
);

CREATE TABLE "DiscussionRateLimit" (
  "userId" UUID NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DiscussionRateLimit_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "DiscussionPost_problemId_parentId_status_createdAt_id_idx" ON "DiscussionPost"("problemId", "parentId", "status", "createdAt", "id");
CREATE INDEX "DiscussionPost_parentId_status_createdAt_id_idx" ON "DiscussionPost"("parentId", "status", "createdAt", "id");
CREATE INDEX "DiscussionPost_authorId_createdAt_idx" ON "DiscussionPost"("authorId", "createdAt");
CREATE INDEX "DiscussionLike_userId_createdAt_idx" ON "DiscussionLike"("userId", "createdAt");
CREATE INDEX "DiscussionRateLimit_expiresAt_idx" ON "DiscussionRateLimit"("expiresAt");

ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionPost" ADD CONSTRAINT "DiscussionPost_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DiscussionPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionLike" ADD CONSTRAINT "DiscussionLike_postId_fkey" FOREIGN KEY ("postId") REFERENCES "DiscussionPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionLike" ADD CONSTRAINT "DiscussionLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscussionRateLimit" ADD CONSTRAINT "DiscussionRateLimit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION enforce_discussion_parent() RETURNS trigger AS $$
DECLARE
  parent_problem UUID;
  grandparent UUID;
BEGIN
  IF NEW."parentId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "problemId", "parentId" INTO parent_problem, grandparent
  FROM "DiscussionPost" WHERE id = NEW."parentId";
  IF parent_problem IS NULL OR grandparent IS NOT NULL OR parent_problem <> NEW."problemId" THEN
    RAISE EXCEPTION 'invalid discussion parent';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DiscussionPost_parent_guard"
BEFORE INSERT OR UPDATE OF "parentId", "problemId" ON "DiscussionPost"
FOR EACH ROW EXECUTE FUNCTION enforce_discussion_parent();
