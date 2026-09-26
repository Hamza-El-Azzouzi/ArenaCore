CREATE TABLE "Credential" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "userId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Credential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Credential_email_normalized" CHECK ("email" = lower(btrim("email"))),
  CONSTRAINT "Credential_password_hash_shape" CHECK (char_length("passwordHash") BETWEEN 80 AND 255)
);

CREATE UNIQUE INDEX "Credential_userId_key" ON "Credential"("userId");
CREATE UNIQUE INDEX "Credential_email_key" ON "Credential"("email");
ALTER TABLE "Credential" ADD CONSTRAINT "Credential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
