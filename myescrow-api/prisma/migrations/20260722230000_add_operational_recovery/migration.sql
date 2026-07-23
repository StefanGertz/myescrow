ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'customer';

ALTER TABLE "Dispute"
  ADD COLUMN "evidenceReminderSentAt" TIMESTAMP(3),
  ADD COLUMN "evidenceEscalatedAt" TIMESTAMP(3);

ALTER TABLE "CancellationRequest" ADD COLUMN "escalatedAt" TIMESTAMP(3);

ALTER TABLE "IdempotencyRecord"
  ADD COLUMN "replayCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReplayedAt" TIMESTAMP(3);

CREATE TABLE "OperationalJob" (
  "id" SERIAL NOT NULL,
  "jobType" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "runAt" TIMESTAMP(3) NOT NULL,
  "lockedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OperationalJob_dedupeKey_key" ON "OperationalJob"("dedupeKey");
CREATE INDEX "OperationalJob_status_runAt_idx" ON "OperationalJob"("status", "runAt");

CREATE TABLE "ReconciliationRun" (
  "id" SERIAL NOT NULL,
  "status" TEXT NOT NULL,
  "checkedEscrows" INTEGER NOT NULL DEFAULT 0,
  "exceptionCount" INTEGER NOT NULL DEFAULT 0,
  "report" JSONB NOT NULL DEFAULT '{}',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "alertedAt" TIMESTAMP(3),
  CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReconciliationRun_startedAt_idx" ON "ReconciliationRun"("startedAt");
CREATE INDEX "ReconciliationRun_status_startedAt_idx" ON "ReconciliationRun"("status", "startedAt");

CREATE TABLE "AuditEvent" (
  "id" SERIAL NOT NULL,
  "dedupeKey" TEXT,
  "escrowId" INTEGER,
  "actorId" TEXT,
  "actorType" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuditEvent_dedupeKey_key" ON "AuditEvent"("dedupeKey");
CREATE INDEX "AuditEvent_escrowId_createdAt_idx" ON "AuditEvent"("escrowId", "createdAt");
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
