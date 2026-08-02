-- Monetary amounts are stored as exact integer cents. PostgreSQL INTEGER tops
-- out at $21,474,836.47, which is below valid escrow totals used by the app.
-- BIGINT preserves the existing representation while removing that accidental
-- 32-bit ceiling across the complete funding, ledger, and resolution lifecycle.
ALTER TABLE "User"
ALTER COLUMN "walletBalanceCents" TYPE BIGINT USING "walletBalanceCents"::BIGINT;

ALTER TABLE "Escrow"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT;

ALTER TABLE "EscrowMilestone"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT,
ALTER COLUMN "requestedAmountCents" TYPE BIGINT USING "requestedAmountCents"::BIGINT;

ALTER TABLE "Dispute"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT,
ALTER COLUMN "amountFrozenCents" TYPE BIGINT USING "amountFrozenCents"::BIGINT,
ALTER COLUMN "proposedSellerCents" TYPE BIGINT USING "proposedSellerCents"::BIGINT,
ALTER COLUMN "proposedBuyerCents" TYPE BIGINT USING "proposedBuyerCents"::BIGINT;

ALTER TABLE "DisputeResolutionAllocation"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT;

ALTER TABLE "CancellationRequest"
ALTER COLUMN "authorizedRefundCents" TYPE BIGINT USING "authorizedRefundCents"::BIGINT,
ALTER COLUMN "refundAmountCents" TYPE BIGINT USING "refundAmountCents"::BIGINT;

ALTER TABLE "WalletTransaction"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT;

ALTER TABLE "EscrowLedgerEntry"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT;

ALTER TABLE "AgreementVersion"
ALTER COLUMN "amountCents" TYPE BIGINT USING "amountCents"::BIGINT;
