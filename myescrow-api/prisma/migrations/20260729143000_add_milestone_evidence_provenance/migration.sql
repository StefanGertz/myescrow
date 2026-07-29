ALTER TABLE "MilestoneEvidenceReference"
ADD COLUMN "storageStatus" TEXT NOT NULL DEFAULT 'legacy_metadata';

ALTER TABLE "MilestoneEvidenceReference"
ADD CONSTRAINT "MilestoneEvidenceReference_storageStatus_check"
CHECK ("storageStatus" IN ('legacy_metadata', 'managed'));

CREATE INDEX "MilestoneEvidenceReference_objectKey_idx"
ON "MilestoneEvidenceReference"("objectKey");
