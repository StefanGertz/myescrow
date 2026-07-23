ALTER TABLE "Dispute"
ADD COLUMN "escrowId" INTEGER,
ADD COLUMN "milestoneId" INTEGER,
ADD COLUMN "openedById" TEXT,
ADD COLUMN "amountFrozenCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reason" TEXT,
ADD COLUMN "evidenceWindowEndsAt" TIMESTAMP(3),
ADD COLUMN "resolutionAuthority" TEXT NOT NULL DEFAULT 'mutual_party_agreement',
ADD COLUMN "resolutionProposedById" TEXT,
ADD COLUMN "proposedSellerCents" INTEGER,
ADD COLUMN "proposedBuyerCents" INTEGER,
ADD COLUMN "resolutionNote" TEXT,
ADD COLUMN "resolvedAt" TIMESTAMP(3);

CREATE TABLE "DisputeEvidenceSubmission" (
    "id" SERIAL NOT NULL,
    "disputeId" INTEGER NOT NULL,
    "submitterId" TEXT NOT NULL,
    "note" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DisputeEvidenceSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DisputeResolutionAllocation" (
    "id" SERIAL NOT NULL,
    "disputeId" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "ledgerEntryId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DisputeResolutionAllocation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CancellationRequest" (
    "id" SERIAL NOT NULL,
    "reference" TEXT NOT NULL,
    "escrowId" INTEGER NOT NULL,
    "requestedById" TEXT NOT NULL,
    "respondedById" TEXT,
    "mode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "refundAmountCents" INTEGER NOT NULL DEFAULT 0,
    "refundLedgerEntryId" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CancellationRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Dispute_escrowId_status_idx" ON "Dispute"("escrowId", "status");
CREATE INDEX "Dispute_milestoneId_status_idx" ON "Dispute"("milestoneId", "status");
CREATE INDEX "Dispute_openedById_idx" ON "Dispute"("openedById");
CREATE UNIQUE INDEX "Dispute_one_active_per_milestone_key"
ON "Dispute"("milestoneId")
WHERE "milestoneId" IS NOT NULL AND "status" IN ('open', 'resolution_proposed', 'resolving');
CREATE INDEX "DisputeEvidenceSubmission_disputeId_submittedAt_idx" ON "DisputeEvidenceSubmission"("disputeId", "submittedAt");
CREATE INDEX "DisputeEvidenceSubmission_submitterId_idx" ON "DisputeEvidenceSubmission"("submitterId");
CREATE UNIQUE INDEX "DisputeResolutionAllocation_ledgerEntryId_key" ON "DisputeResolutionAllocation"("ledgerEntryId");
CREATE INDEX "DisputeResolutionAllocation_disputeId_idx" ON "DisputeResolutionAllocation"("disputeId");
CREATE UNIQUE INDEX "CancellationRequest_reference_key" ON "CancellationRequest"("reference");
CREATE UNIQUE INDEX "CancellationRequest_refundLedgerEntryId_key" ON "CancellationRequest"("refundLedgerEntryId");
CREATE INDEX "CancellationRequest_escrowId_status_idx" ON "CancellationRequest"("escrowId", "status");
CREATE INDEX "CancellationRequest_requestedById_idx" ON "CancellationRequest"("requestedById");
CREATE UNIQUE INDEX "CancellationRequest_one_active_per_escrow_key"
ON "CancellationRequest"("escrowId")
WHERE "status" IN ('pending', 'escalated');

ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_escrowId_fkey"
FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_milestoneId_fkey"
FOREIGN KEY ("milestoneId") REFERENCES "EscrowMilestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_openedById_fkey"
FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolutionProposedById_fkey"
FOREIGN KEY ("resolutionProposedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisputeEvidenceSubmission" ADD CONSTRAINT "DisputeEvidenceSubmission_disputeId_fkey"
FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DisputeEvidenceSubmission" ADD CONSTRAINT "DisputeEvidenceSubmission_submitterId_fkey"
FOREIGN KEY ("submitterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisputeResolutionAllocation" ADD CONSTRAINT "DisputeResolutionAllocation_disputeId_fkey"
FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DisputeResolutionAllocation" ADD CONSTRAINT "DisputeResolutionAllocation_ledgerEntryId_fkey"
FOREIGN KEY ("ledgerEntryId") REFERENCES "EscrowLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_escrowId_fkey"
FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_requestedById_fkey"
FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_respondedById_fkey"
FOREIGN KEY ("respondedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CancellationRequest" ADD CONSTRAINT "CancellationRequest_refundLedgerEntryId_fkey"
FOREIGN KEY ("refundLedgerEntryId") REFERENCES "EscrowLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
