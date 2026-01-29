import type { Prisma, PrismaClient } from "@prisma/client";

async function incrementSequence(tx: Prisma.TransactionClient, id: string, defaultStart: number) {
  const existing = await tx.sequence.findUnique({ where: { id } });
  if (!existing) {
    const nextValue = defaultStart;
    await tx.sequence.create({ data: { id, currentValue: defaultStart + 1 } });
    return nextValue;
  }
  const nextValue = existing.currentValue;
  await tx.sequence.update({
    where: { id },
    data: { currentValue: { increment: 1 } },
  });
  return nextValue;
}

function isPrismaClient(client: PrismaClient | Prisma.TransactionClient): client is PrismaClient {
  return typeof (client as PrismaClient).$transaction === "function";
}

export function getNextSequenceValue(prisma: PrismaClient | Prisma.TransactionClient, id: string, defaultStart = 1) {
  if (isPrismaClient(prisma)) {
    return prisma.$transaction((tx) => incrementSequence(tx, id, defaultStart));
  }
  return incrementSequence(prisma, id, defaultStart);
}
