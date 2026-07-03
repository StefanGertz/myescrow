ALTER TABLE "EscrowMilestone"
ADD COLUMN "deadline" TIMESTAMP(3),
ADD COLUMN "requestedTitle" TEXT,
ADD COLUMN "requestedDescription" TEXT,
ADD COLUMN "requestedAmountCents" INTEGER,
ADD COLUMN "requestedDeadline" TIMESTAMP(3),
ADD COLUMN "changeRequestNote" TEXT,
ADD COLUMN "changeRequestedAt" TIMESTAMP(3);
