CREATE TABLE "Notification" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "kind" VARCHAR(50) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "body" VARCHAR(500) NOT NULL,
  "href" VARCHAR(500),
  "dedupeKey" VARCHAR(200),
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_href_check" CHECK ("href" IS NULL OR "href" ~ '^/[A-Za-z0-9/_?=&.-]*$')
);

CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
CREATE INDEX "Notification_userId_readAt_createdAt_id_idx" ON "Notification"("userId", "readAt", "createdAt", "id");
CREATE INDEX "Notification_userId_createdAt_id_idx" ON "Notification"("userId", "createdAt", "id");

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
