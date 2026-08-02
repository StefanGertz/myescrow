CREATE TABLE "EscrowCreationDraft" (
    "userId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EscrowCreationDraft_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "EscrowCreationDraft_revision_check" CHECK ("revision" >= 0),
    CONSTRAINT "EscrowCreationDraft_state_check" CHECK (
        ("data" IS NULL AND "deletedAt" IS NOT NULL)
        OR ("data" IS NOT NULL AND "deletedAt" IS NULL)
    )
);

ALTER TABLE "EscrowCreationDraft" ADD CONSTRAINT "EscrowCreationDraft_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
