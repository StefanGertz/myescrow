-- AlterTable
ALTER TABLE "Escrow"
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "buyerId" TEXT,
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "counterpartyEmail" TEXT,
ADD COLUMN "creatorRole" TEXT,
ADD COLUMN "fundedAt" TIMESTAMP(3),
ADD COLUMN "fundingStatus" TEXT NOT NULL DEFAULT 'not_funded',
ADD COLUMN "lifecycleStatus" TEXT NOT NULL DEFAULT 'pending_approval',
ADD COLUMN "rejectedAt" TIMESTAMP(3),
ADD COLUMN "sellerId" TEXT;

-- Backfill existing escrows so old rows remain valid after the new workflow lands.
UPDATE "Escrow"
SET
  "buyerId" = COALESCE("buyerId", "ownerId"),
  "sellerId" = COALESCE("sellerId", "ownerId"),
  "creatorRole" = COALESCE("creatorRole", 'buyer'),
  "counterpartyEmail" = COALESCE("counterpartyEmail", 'legacy-' || "reference" || '@myescrow.local'),
  "lifecycleStatus" = CASE
    WHEN "lifecycleStatus" IS NOT NULL THEN "lifecycleStatus"
    WHEN "counterpartyApproved" THEN 'funding_pending'
    ELSE 'pending_approval'
  END,
  "fundingStatus" = COALESCE("fundingStatus", 'not_funded');

ALTER TABLE "Escrow"
ALTER COLUMN "buyerId" SET NOT NULL,
ALTER COLUMN "sellerId" SET NOT NULL,
ALTER COLUMN "creatorRole" SET NOT NULL,
ALTER COLUMN "counterpartyEmail" SET NOT NULL;

-- CreateTable
CREATE TABLE "EscrowMilestone" (
    "id" SERIAL NOT NULL,
    "escrowId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amountCents" INTEGER NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "releasedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscrowMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Escrow_buyerId_idx" ON "Escrow"("buyerId");

-- CreateIndex
CREATE INDEX "Escrow_sellerId_idx" ON "Escrow"("sellerId");

-- CreateIndex
CREATE INDEX "Escrow_lifecycleStatus_idx" ON "Escrow"("lifecycleStatus");

-- CreateIndex
CREATE INDEX "EscrowMilestone_escrowId_orderIndex_idx" ON "EscrowMilestone"("escrowId", "orderIndex");

-- AddForeignKey
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowMilestone" ADD CONSTRAINT "EscrowMilestone_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
