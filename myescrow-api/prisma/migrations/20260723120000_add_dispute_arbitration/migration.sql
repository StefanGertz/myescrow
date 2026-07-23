ALTER TABLE "Dispute"
ADD COLUMN "arbitrationRequestedAt" TIMESTAMP(3),
ADD COLUMN "arbitrationRequestedById" TEXT;

ALTER TABLE "Dispute"
ADD CONSTRAINT "Dispute_arbitrationRequestedById_fkey"
FOREIGN KEY ("arbitrationRequestedById") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Dispute_arbitrationRequestedById_idx"
ON "Dispute"("arbitrationRequestedById");

DROP INDEX "Dispute_one_active_per_milestone_key";
CREATE UNIQUE INDEX "Dispute_one_active_per_milestone_key"
ON "Dispute"("milestoneId")
WHERE "milestoneId" IS NOT NULL
AND "status" IN ('open', 'resolution_proposed', 'resolving', 'arbitration_requested');
