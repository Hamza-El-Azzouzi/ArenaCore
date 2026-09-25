ALTER TABLE "User" ADD COLUMN "username" TEXT;
ALTER TABLE "User" ADD COLUMN "bio" TEXT;
ALTER TABLE "User" ADD COLUMN "location" TEXT;
ALTER TABLE "User" ADD COLUMN "website" TEXT;
ALTER TABLE "User" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "User"
SET "username" = 'user_' || replace(id::text, '-', '');

ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "username" SET DEFAULT ('user_' || replace(gen_random_uuid()::text, '-', ''));

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

ALTER TABLE "User" ADD CONSTRAINT "User_username_format" CHECK (
  "username" ~ '^[a-z0-9][a-z0-9_]{1,38}[a-z0-9]$'
);
ALTER TABLE "User" ADD CONSTRAINT "User_profile_bounds" CHECK (
  ("bio" IS NULL OR char_length("bio") <= 280) AND
  ("location" IS NULL OR char_length("location") <= 100) AND
  ("website" IS NULL OR char_length("website") <= 2048)
);
