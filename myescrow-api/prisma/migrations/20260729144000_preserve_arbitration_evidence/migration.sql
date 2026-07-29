ALTER TABLE "MilestoneEvidenceReference"
DROP CONSTRAINT "MilestoneEvidenceReference_submissionId_fkey";

ALTER TABLE "MilestoneEvidenceReference"
ADD CONSTRAINT "MilestoneEvidenceReference_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "MilestoneSubmission"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DisputeEvidenceSubmission"
DROP CONSTRAINT "DisputeEvidenceSubmission_disputeId_fkey";

ALTER TABLE "DisputeEvidenceSubmission"
ADD CONSTRAINT "DisputeEvidenceSubmission_disputeId_fkey"
FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DisputeEvidenceReference"
DROP CONSTRAINT "DisputeEvidenceReference_submissionId_fkey";

ALTER TABLE "DisputeEvidenceReference"
ADD CONSTRAINT "DisputeEvidenceReference_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "DisputeEvidenceSubmission"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
