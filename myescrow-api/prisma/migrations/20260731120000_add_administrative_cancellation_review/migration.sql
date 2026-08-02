ALTER TABLE "CancellationRequest"
ADD COLUMN "administrativeAction" TEXT,
ADD COLUMN "reviewNote" TEXT,
ADD COLUMN "proceduralReasonCode" TEXT,
ADD COLUMN "policyReference" TEXT,
ADD COLUMN "authorityType" TEXT,
ADD COLUMN "authorityReference" TEXT,
ADD COLUMN "authorityEffectiveAt" TIMESTAMP(3),
ADD COLUMN "authorityDocumentSha256" TEXT,
ADD COLUMN "authorityVerifiedAt" TIMESTAMP(3),
ADD COLUMN "authorizedRefundCents" INTEGER,
ADD COLUMN "lastReviewedAt" TIMESTAMP(3),
ADD COLUMN "preReviewLifecycleStatus" TEXT,
ADD COLUMN "preReviewStage" TEXT,
ADD COLUMN "preReviewDueDescription" TEXT,
ADD COLUMN "preReviewEscrowStatus" TEXT,
ADD COLUMN "referredDisputeId" INTEGER;

CREATE UNIQUE INDEX "CancellationRequest_referredDisputeId_key"
ON "CancellationRequest"("referredDisputeId");

ALTER TABLE "CancellationRequest"
ADD CONSTRAINT "CancellationRequest_referredDisputeId_fkey"
FOREIGN KEY ("referredDisputeId") REFERENCES "Dispute"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CancellationReviewMessage" (
    "id" SERIAL NOT NULL,
    "cancellationRequestId" INTEGER NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorRole" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CancellationReviewMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CancellationReviewMessage_cancellationRequestId_createdAt_id_idx"
ON "CancellationReviewMessage"("cancellationRequestId", "createdAt", "id");

CREATE INDEX "CancellationReviewMessage_authorId_createdAt_idx"
ON "CancellationReviewMessage"("authorId", "createdAt");

ALTER TABLE "CancellationReviewMessage"
ADD CONSTRAINT "CancellationReviewMessage_cancellationRequestId_fkey"
FOREIGN KEY ("cancellationRequestId") REFERENCES "CancellationRequest"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CancellationReviewMessage"
ADD CONSTRAINT "CancellationReviewMessage_authorId_fkey"
FOREIGN KEY ("authorId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
