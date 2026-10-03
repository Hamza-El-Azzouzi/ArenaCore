CREATE TYPE "ProfileVisibility" AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE "ThemePreference" AS ENUM ('SYSTEM', 'DARK', 'LIGHT');

ALTER TABLE "User"
  ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "profileVisibility" "ProfileVisibility" NOT NULL DEFAULT 'PUBLIC',
  ADD COLUMN "themePreference" "ThemePreference" NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "productNotifications" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "competitionNotifications" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deactivatedAt" TIMESTAMP(3);

ALTER TABLE "User"
  ADD CONSTRAINT "User_avatar_url_shape" CHECK (
    "avatarUrl" IS NULL OR (
      char_length("avatarUrl") <= 2048
      AND "avatarUrl" ~ '^https://'
      AND "avatarUrl" !~ '[[:cntrl:]]'
    )
  );

CREATE INDEX "User_profileVisibility_deactivatedAt_idx"
  ON "User"("profileVisibility", "deactivatedAt");
