-- Allow escrows to exist before the invited counterparty has an account.
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_buyerId_fkey";
ALTER TABLE "Escrow" DROP CONSTRAINT "Escrow_sellerId_fkey";

ALTER TABLE "Escrow"
ALTER COLUMN "buyerId" DROP NOT NULL,
ALTER COLUMN "sellerId" DROP NOT NULL;

ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Escrow_counterpartyEmail_idx" ON "Escrow"("counterpartyEmail");
