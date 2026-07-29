ALTER TABLE "DisputeEvidenceReference"
ADD COLUMN "storageStatus" TEXT NOT NULL DEFAULT 'legacy_metadata';

ALTER TABLE "DisputeEvidenceReference"
ADD CONSTRAINT "DisputeEvidenceReference_storageStatus_check"
CHECK ("storageStatus" IN ('legacy_metadata', 'managed'));

CREATE INDEX "DisputeEvidenceReference_objectKey_idx"
ON "DisputeEvidenceReference"("objectKey");
