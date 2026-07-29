-- CreateTable
CREATE TABLE "EscrowMessage" (
    "id" SERIAL NOT NULL,
    "escrowId" INTEGER NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscrowMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EscrowMessage_escrowId_createdAt_id_idx" ON "EscrowMessage"("escrowId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "EscrowMessage_senderId_createdAt_idx" ON "EscrowMessage"("senderId", "createdAt");

-- AddForeignKey
ALTER TABLE "EscrowMessage" ADD CONSTRAINT "EscrowMessage_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "Escrow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscrowMessage" ADD CONSTRAINT "EscrowMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
