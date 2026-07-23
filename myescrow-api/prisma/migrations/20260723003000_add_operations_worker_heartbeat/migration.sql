CREATE TABLE "OperationalWorkerState" (
  "id" TEXT NOT NULL,
  "lastStartedAt" TIMESTAMP(3),
  "lastCompletedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OperationalWorkerState_pkey" PRIMARY KEY ("id")
);
