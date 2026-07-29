CREATE TABLE "DisputeEvidenceReference" (
    "id" SERIAL NOT NULL,
    "submissionId" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvidenceReference_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DisputeEvidenceReference_submissionId_idx"
ON "DisputeEvidenceReference"("submissionId");

ALTER TABLE "DisputeEvidenceReference"
ADD CONSTRAINT "DisputeEvidenceReference_submissionId_fkey"
FOREIGN KEY ("submissionId") REFERENCES "DisputeEvidenceSubmission"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
