-- Store one reusable business identity per user.
CREATE TABLE "BusinessProfile" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "registrationCountry" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "registeredAddress" TEXT NOT NULL,
    "representativeTitle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessProfile_userId_key" ON "BusinessProfile"("userId");

ALTER TABLE "BusinessProfile"
ADD CONSTRAINT "BusinessProfile_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Snapshot party identities on each escrow so signed agreements remain immutable.
ALTER TABLE "Escrow"
ADD COLUMN "creatorPartySnapshot" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "counterpartyPartySnapshot" JSONB;
