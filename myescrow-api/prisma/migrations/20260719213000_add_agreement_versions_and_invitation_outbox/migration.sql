ALTER TABLE "Escrow"
ADD COLUMN "currentAgreementVersionId" INTEGER,
ADD COLUMN "invitationExpiresAt" TIMESTAMP(3),
ADD COLUMN "agreementResponseDueAt" TIMESTAMP(3);

CREATE TABLE "AgreementVersion" (
    "id" SERIAL NOT NULL,
    "escrowId" INTEGER NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "termsHash" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "creatorRole" TEXT NOT NULL,
    "creatorParty" JSONB NOT NULL,
    "counterpartyParty" JSONB,
    "milestones" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'current',
    "createdById" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgreementVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgreementSignature" (
    "id" SERIAL NOT NULL,
    "agreementVersionId" INTEGER NOT NULL,
    "signerId" TEXT NOT NULL,
    "signerRole" TEXT NOT NULL,
    "signatureDataUrl" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgreementSignature_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvitationDelivery" (
    "id" SERIAL NOT NULL,
    "escrowId" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "providerId" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "responseDueAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvitationDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboxEvent" (
    "id" SERIAL NOT NULL,
    "invitationDeliveryId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "providerId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Escrow_currentAgreementVersionId_key" ON "Escrow"("currentAgreementVersionId");
CREATE UNIQUE INDEX "AgreementVersion_escrowId_versionNumber_key" ON "AgreementVersion"("escrowId", "versionNumber");
CREATE INDEX "AgreementVersion_escrowId_status_idx" ON "AgreementVersion"("escrowId", "status");
CREATE INDEX "AgreementVersion_createdById_idx" ON "AgreementVersion"("createdById");
CREATE UNIQUE INDEX "AgreementSignature_agreementVersionId_signerId_key" ON "AgreementSignature"("agreementVersionId", "signerId");
CREATE INDEX "AgreementSignature_signerId_idx" ON "AgreementSignature"("signerId");
CREATE INDEX "InvitationDelivery_escrowId_createdAt_idx" ON "InvitationDelivery"("escrowId", "createdAt");
CREATE INDEX "InvitationDelivery_status_nextAttemptAt_idx" ON "InvitationDelivery"("status", "nextAttemptAt");
CREATE INDEX "InvitationDelivery_recipient_idx" ON "InvitationDelivery"("recipient");
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
CREATE INDEX "OutboxEvent_invitationDeliveryId_idx" ON "OutboxEvent"("invitationDeliveryId");

ALTER TABLE "AgreementVersion" ADD CONSTRAINT "AgreementVersion_escrowId_fkey"
FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgreementVersion" ADD CONSTRAINT "AgreementVersion_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgreementSignature" ADD CONSTRAINT "AgreementSignature_agreementVersionId_fkey"
FOREIGN KEY ("agreementVersionId") REFERENCES "AgreementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgreementSignature" ADD CONSTRAINT "AgreementSignature_signerId_fkey"
FOREIGN KEY ("signerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvitationDelivery" ADD CONSTRAINT "InvitationDelivery_escrowId_fkey"
FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_invitationDeliveryId_fkey"
FOREIGN KEY ("invitationDeliveryId") REFERENCES "InvitationDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Escrow" ADD CONSTRAINT "Escrow_currentAgreementVersionId_fkey"
FOREIGN KEY ("currentAgreementVersionId") REFERENCES "AgreementVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill one immutable version for every existing escrow.
INSERT INTO "AgreementVersion" (
    "escrowId", "versionNumber", "termsHash", "title", "description", "amountCents",
    "creatorRole", "creatorParty", "counterpartyParty", "milestones", "status",
    "createdById", "lockedAt", "createdAt"
)
SELECT
    e."id", 1,
    md5(e."reference" || ':' || e."title" || ':' || e."amountCents"::text || ':' || e."updatedAt"::text),
    e."title", e."description", e."amountCents", e."creatorRole",
    e."creatorPartySnapshot", e."counterpartyPartySnapshot",
    COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'milestoneId', m."id", 'title', m."title", 'description', m."description",
            'amountCents', m."amountCents", 'deadline', m."deadline", 'orderIndex', m."orderIndex"
        ) ORDER BY m."orderIndex")
        FROM "EscrowMilestone" m WHERE m."escrowId" = e."id"
    ), '[]'::jsonb),
    CASE WHEN e."counterpartyApproved" THEN 'locked' ELSE 'current' END,
    e."ownerId", CASE WHEN e."counterpartyApproved" THEN e."approvedAt" ELSE NULL END,
    e."createdAt"
FROM "Escrow" e;

UPDATE "Escrow" e
SET "currentAgreementVersionId" = v."id",
    "invitationExpiresAt" = e."createdAt" + INTERVAL '14 days',
    "agreementResponseDueAt" = e."createdAt" + INTERVAL '7 days'
FROM "AgreementVersion" v
WHERE v."escrowId" = e."id" AND v."versionNumber" = 1;

INSERT INTO "AgreementSignature" (
    "agreementVersionId", "signerId", "signerRole", "signatureDataUrl", "evidenceHash", "signedAt"
)
SELECT v."id", e."ownerId", e."creatorRole", e."creatorSignatureDataUrl",
       md5(e."creatorSignatureDataUrl"), e."createdAt"
FROM "Escrow" e JOIN "AgreementVersion" v ON v."escrowId" = e."id"
WHERE e."creatorSignatureDataUrl" IS NOT NULL;

INSERT INTO "AgreementSignature" (
    "agreementVersionId", "signerId", "signerRole", "signatureDataUrl", "evidenceHash", "signedAt"
)
SELECT v."id",
       CASE WHEN e."ownerId" = e."buyerId" THEN e."sellerId" ELSE e."buyerId" END,
       CASE WHEN e."creatorRole" = 'buyer' THEN 'seller' ELSE 'buyer' END,
       e."counterpartySignatureDataUrl", md5(e."counterpartySignatureDataUrl"),
       COALESCE(e."approvedAt", e."updatedAt")
FROM "Escrow" e JOIN "AgreementVersion" v ON v."escrowId" = e."id"
WHERE e."counterpartySignatureDataUrl" IS NOT NULL
  AND (CASE WHEN e."ownerId" = e."buyerId" THEN e."sellerId" ELSE e."buyerId" END) IS NOT NULL;

INSERT INTO "InvitationDelivery" (
    "escrowId", "recipient", "status", "attemptCount", "expiresAt", "responseDueAt",
    "acceptedAt", "createdAt", "updatedAt"
)
SELECT e."id", e."counterpartyEmail",
       CASE WHEN e."counterpartyApproved" THEN 'accepted' ELSE 'delivered' END,
       1, e."invitationExpiresAt", e."agreementResponseDueAt",
       CASE WHEN e."counterpartyApproved" THEN e."approvedAt" ELSE NULL END,
       e."createdAt", e."updatedAt"
FROM "Escrow" e;
