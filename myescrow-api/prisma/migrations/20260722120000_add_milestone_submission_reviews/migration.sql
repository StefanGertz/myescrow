ALTER TABLE "EscrowMilestone"
ADD COLUMN "reviewDeadline" TIMESTAMP(3),
ADD COLUMN "reminderAt" TIMESTAMP(3),
ADD COLUMN "reminderSentAt" TIMESTAMP(3),
ADD COLUMN "reviewOverdueAt" TIMESTAMP(3);

UPDATE "EscrowMilestone"
SET "status" = CASE
  WHEN "status" = 'pending' THEN 'not_started'
  WHEN "status" = 'rejected' THEN 'revision_requested'
  ELSE "status"
END;

CREATE TABLE "MilestoneSubmission" (
    "id" SERIAL NOT NULL,
    "milestoneId" INTEGER NOT NULL,
    "submitterId" TEXT NOT NULL,
    "submissionNumber" INTEGER NOT NULL,
    "note" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewDeadline" TIMESTAMP(3) NOT NULL,
    "reminderAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MilestoneSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MilestoneEvidenceReference" (
    "id" SERIAL NOT NULL,
    "submissionId" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MilestoneEvidenceReference_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MilestoneReview" (
    "id" SERIAL NOT NULL,
    "submissionId" INTEGER NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MilestoneReview_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MilestoneSubmission_milestoneId_submissionNumber_key"
ON "MilestoneSubmission"("milestoneId", "submissionNumber");
CREATE INDEX "MilestoneSubmission_submitterId_idx" ON "MilestoneSubmission"("submitterId");
CREATE INDEX "MilestoneEvidenceReference_submissionId_idx" ON "MilestoneEvidenceReference"("submissionId");
CREATE UNIQUE INDEX "MilestoneReview_submissionId_key" ON "MilestoneReview"("submissionId");
CREATE INDEX "MilestoneReview_reviewerId_idx" ON "MilestoneReview"("reviewerId");
CREATE INDEX "EscrowMilestone_status_reviewDeadline_idx" ON "EscrowMilestone"("status", "reviewDeadline");

ALTER TABLE "MilestoneSubmission" ADD CONSTRAINT "MilestoneSubmission_milestoneId_fkey"
FOREIGN KEY ("milestoneId") REFERENCES "EscrowMilestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MilestoneSubmission" ADD CONSTRAINT "MilestoneSubmission_submitterId_fkey"
FOREIGN KEY ("submitterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MilestoneEvidenceReference" ADD CONSTRAINT "MilestoneEvidenceReference_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "MilestoneSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MilestoneReview" ADD CONSTRAINT "MilestoneReview_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "MilestoneSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MilestoneReview" ADD CONSTRAINT "MilestoneReview_reviewerId_fkey"
FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
