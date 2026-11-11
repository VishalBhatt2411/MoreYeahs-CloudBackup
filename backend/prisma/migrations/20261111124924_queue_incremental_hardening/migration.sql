-- CreateEnum
CREATE TYPE "RunMode" AS ENUM ('FULL', 'INCREMENTAL');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'AUDITOR';

-- AlterTable
ALTER TABLE "BackupItem" ADD COLUMN     "changedCount" INTEGER,
ADD COLUMN     "deletedCount" INTEGER,
ADD COLUMN     "files" JSONB,
ADD COLUMN     "mode" "RunMode";

-- AlterTable
ALTER TABLE "BackupRun" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "maxAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "mode" "RunMode" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "workerId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHoldAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EmailVerification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObjectCheckpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "objectName" TEXT NOT NULL,
    "watermark" TIMESTAMP(3) NOT NULL,
    "lastFilePath" TEXT NOT NULL,
    "lastItemId" TEXT,
    "lastFullAt" TIMESTAMP(3) NOT NULL,
    "needsFull" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObjectCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailVerification_tokenHash_key" ON "EmailVerification"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailVerification_userId_idx" ON "EmailVerification"("userId");

-- CreateIndex
CREATE INDEX "ObjectCheckpoint_tenantId_idx" ON "ObjectCheckpoint"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectCheckpoint_connectionId_objectName_key" ON "ObjectCheckpoint"("connectionId", "objectName");

-- CreateIndex
CREATE INDEX "BackupRun_status_createdAt_idx" ON "BackupRun"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectCheckpoint" ADD CONSTRAINT "ObjectCheckpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObjectCheckpoint" ADD CONSTRAINT "ObjectCheckpoint_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "OrgConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing people were already using the app: treat their email as verified.
UPDATE "User" SET "emailVerifiedAt" = "createdAt" WHERE "emailVerifiedAt" IS NULL;
