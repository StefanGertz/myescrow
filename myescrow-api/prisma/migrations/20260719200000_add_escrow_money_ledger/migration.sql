-- Immutable financial history for each escrow movement.
CREATE TABLE "EscrowLedgerEntry" (
    "id" SERIAL NOT NULL,
    "escrowId" INTEGER NOT NULL,
    "milestoneId" INTEGER,
    "movementType" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "idempotencyKey" TEXT NOT NULL,
    "businessReference" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "sourceCommand" TEXT NOT NULL,
    "paymentProviderRef" TEXT,
    "walletTransactionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EscrowLedgerEntry_nonzero_amount" CHECK ("amountCents" <> 0),
    CONSTRAINT "EscrowLedgerEntry_movement_type" CHECK (
        "movementType" IN ('fund', 'release', 'refund', 'settlement_release', 'settlement_refund')
    )
);

CREATE TABLE "IdempotencyRecord" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EscrowLedgerEntry_businessReference_key"
ON "EscrowLedgerEntry"("businessReference");
CREATE UNIQUE INDEX "EscrowLedgerEntry_walletTransactionId_key"
ON "EscrowLedgerEntry"("walletTransactionId");
CREATE UNIQUE INDEX "EscrowLedgerEntry_escrowId_idempotencyKey_key"
ON "EscrowLedgerEntry"("escrowId", "idempotencyKey");
CREATE INDEX "EscrowLedgerEntry_escrowId_createdAt_idx"
ON "EscrowLedgerEntry"("escrowId", "createdAt");
CREATE INDEX "EscrowLedgerEntry_milestoneId_idx"
ON "EscrowLedgerEntry"("milestoneId");
CREATE INDEX "EscrowLedgerEntry_actorId_idx"
ON "EscrowLedgerEntry"("actorId");
CREATE UNIQUE INDEX "IdempotencyRecord_userId_key_key"
ON "IdempotencyRecord"("userId", "key");
CREATE INDEX "IdempotencyRecord_createdAt_idx"
ON "IdempotencyRecord"("createdAt");

ALTER TABLE "EscrowLedgerEntry"
ADD CONSTRAINT "EscrowLedgerEntry_escrowId_fkey"
FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowLedgerEntry"
ADD CONSTRAINT "EscrowLedgerEntry_milestoneId_fkey"
FOREIGN KEY ("milestoneId") REFERENCES "EscrowMilestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowLedgerEntry"
ADD CONSTRAINT "EscrowLedgerEntry_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscrowLedgerEntry"
ADD CONSTRAINT "EscrowLedgerEntry_walletTransactionId_fkey"
FOREIGN KEY ("walletTransactionId") REFERENCES "WalletTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IdempotencyRecord"
ADD CONSTRAINT "IdempotencyRecord_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the best-known financial history. Reconciliation reports any legacy
-- escrow whose milestone data cannot explain its current balance.
INSERT INTO "EscrowLedgerEntry" (
    "escrowId", "movementType", "amountCents", "currency", "idempotencyKey",
    "businessReference", "actorId", "sourceCommand", "createdAt"
)
SELECT
    e."id", 'fund', e."amountCents", 'USD', 'backfill:fund:' || e."reference",
    'escrow:' || e."reference" || ':fund', e."buyerId", 'legacy_backfill',
    COALESCE(e."fundedAt", e."updatedAt")
FROM "Escrow" e
WHERE e."fundingStatus" = 'funded' AND e."buyerId" IS NOT NULL;

INSERT INTO "EscrowLedgerEntry" (
    "escrowId", "milestoneId", "movementType", "amountCents", "currency",
    "idempotencyKey", "businessReference", "actorId", "sourceCommand", "createdAt"
)
SELECT
    e."id", m."id", 'release', -m."amountCents", 'USD',
    'backfill:release:' || m."id",
    'escrow:' || e."reference" || ':milestone:' || m."id" || ':release',
    e."buyerId", 'legacy_backfill', COALESCE(m."releasedAt", m."updatedAt")
FROM "EscrowMilestone" m
JOIN "Escrow" e ON e."id" = m."escrowId"
WHERE m."status" = 'released' AND e."buyerId" IS NOT NULL;
