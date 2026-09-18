CREATE INDEX "Session_userId_revokedAt_expiresAt_idx" ON "Session"("userId", "revokedAt", "expiresAt");
CREATE INDEX "AuthAttempt_browserTokenHash_idx" ON "AuthAttempt"("browserTokenHash");
