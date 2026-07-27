ALTER TABLE "Escrow"
ADD COLUMN "fundingMode" TEXT;

UPDATE "Escrow"
SET "fundingMode" = 'full'
WHERE "fundingStatus" = 'funded';
