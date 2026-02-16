import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { promises as fs } from "fs";
import path from "path";
import type { DatabaseSchema } from "../src/types/database";

const prisma = new PrismaClient();

async function main() {
  const dataPath = path.resolve(__dirname, "../data/store.json");
  const raw = await fs.readFile(dataPath, "utf8");
  const data = JSON.parse(raw) as DatabaseSchema;

  await prisma.$transaction([
    prisma.walletTransaction.deleteMany(),
    prisma.timelineEvent.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.dispute.deleteMany(),
    prisma.escrow.deleteMany(),
    prisma.user.deleteMany(),
    prisma.sequence.deleteMany(),
  ]);

  await prisma.user.createMany({
    data: data.users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      passwordHash: user.passwordHash,
      walletBalanceCents: user.walletBalance,
      emailVerified: true,
      createdAt: new Date(user.createdAt),
      updatedAt: new Date(user.updatedAt),
    })),
  });

  for (const escrow of data.escrows) {
    await prisma.escrow.create({
      data: {
        reference: escrow.reference,
        ownerId: escrow.ownerId,
        title: escrow.title,
        counterpart: escrow.counterpart,
        amountCents: escrow.amount,
        stage: escrow.stage,
        dueDescription: escrow.dueDescription,
        status: escrow.status,
        counterpartyApproved: escrow.counterpartyApproved,
        category: escrow.category,
        description: escrow.description,
        createdAt: new Date(escrow.createdAt),
        updatedAt: new Date(escrow.updatedAt),
      },
    });
  }

  for (const dispute of data.disputes) {
    await prisma.dispute.create({
      data: {
        reference: dispute.reference,
        ownerId: dispute.ownerId,
        title: dispute.title,
        ownerTeam: dispute.ownerTeam,
        amountCents: dispute.amount,
        updatedLabel: dispute.updatedLabel,
        priority: dispute.priority,
        status: dispute.status,
        workspaceLaunched: dispute.workspaceLaunched ?? false,
        createdAt: new Date(dispute.createdAt),
        updatedAt: new Date(dispute.updatedAt),
      },
    });
  }

  await prisma.notification.createMany({
    data: data.notifications.map((notification) => ({
      id: notification.id,
      userId: notification.userId,
      label: notification.label,
      detail: notification.detail,
      meta: notification.meta,
      txId: notification.txId,
      createdAt: new Date(notification.createdAt),
    })),
  });

  await prisma.timelineEvent.createMany({
    data: data.timelineEvents.map((event) => ({
      id: event.id,
      userId: event.userId,
      title: event.title,
      meta: event.meta,
      timeLabel: event.timeLabel,
      status: event.status,
      createdAt: new Date(event.createdAt),
    })),
  });

  await prisma.walletTransaction.createMany({
    data: data.walletTransactions.map(({ id: _id, amount, ...transaction }) => ({
      ...transaction,
      amountCents: amount,
      createdAt: new Date(transaction.createdAt),
    })),
  });

  await prisma.sequence.createMany({
    data: [
      { id: "escrow", currentValue: data.meta.nextEscrowSequence },
      { id: "dispute", currentValue: data.meta.nextDisputeSequence },
      { id: "notification", currentValue: data.meta.nextNotificationSequence },
      { id: "timeline", currentValue: data.meta.nextTimelineSequence },
      { id: "user", currentValue: data.meta.nextUserSequence },
    ],
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
