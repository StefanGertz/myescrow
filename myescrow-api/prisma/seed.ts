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
    prisma.idempotencyRecord.deleteMany(),
    prisma.escrowLedgerEntry.deleteMany(),
    prisma.walletTransaction.deleteMany(),
    prisma.escrowMilestone.deleteMany(),
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
        buyerId: escrow.buyerId,
        sellerId: escrow.sellerId,
        creatorRole: escrow.creatorRole,
        counterpartyEmail: escrow.counterpartyEmail,
        title: escrow.title,
        counterpart: escrow.counterpart,
        amountCents: escrow.amount,
        stage: escrow.stage,
        dueDescription: escrow.dueDescription,
        status: escrow.status,
        counterpartyApproved: escrow.counterpartyApproved,
        lifecycleStatus: escrow.lifecycleStatus,
        fundingStatus: escrow.fundingStatus,
        category: escrow.category,
        description: escrow.description,
        approvedAt: escrow.approvedAt ? new Date(escrow.approvedAt) : undefined,
        fundedAt: escrow.fundedAt ? new Date(escrow.fundedAt) : undefined,
        rejectedAt: escrow.rejectedAt ? new Date(escrow.rejectedAt) : undefined,
        cancelledAt: escrow.cancelledAt ? new Date(escrow.cancelledAt) : undefined,
        createdAt: new Date(escrow.createdAt),
        updatedAt: new Date(escrow.updatedAt),
      },
    });
  }

  await prisma.escrowMilestone.createMany({
    data: data.escrowMilestones.map((milestone) => ({
      escrowId: milestone.escrowId,
      title: milestone.title,
      description: milestone.description,
      amountCents: milestone.amount,
      orderIndex: milestone.orderIndex,
      status: milestone.status,
      releasedAt: milestone.releasedAt ? new Date(milestone.releasedAt) : undefined,
      rejectedAt: milestone.rejectedAt ? new Date(milestone.rejectedAt) : undefined,
      createdAt: new Date(milestone.createdAt),
      updatedAt: new Date(milestone.updatedAt),
    })),
  });

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

  const fundedEscrows = await prisma.escrow.findMany({
    where: { fundingStatus: "funded", buyerId: { not: null } },
    include: { milestones: true },
  });
  for (const escrow of fundedEscrows) {
    await prisma.escrowLedgerEntry.create({
      data: {
        escrowId: escrow.id,
        movementType: "fund",
        amountCents: escrow.amountCents,
        idempotencyKey: `seed:fund:${escrow.reference}`,
        businessReference: `escrow:${escrow.reference}:fund`,
        actorId: escrow.buyerId!,
        sourceCommand: "seed_backfill",
        createdAt: escrow.fundedAt ?? escrow.updatedAt,
      },
    });
    for (const milestone of escrow.milestones.filter((item) => item.status === "released")) {
      await prisma.escrowLedgerEntry.create({
        data: {
          escrowId: escrow.id,
          milestoneId: milestone.id,
          movementType: "release",
          amountCents: -milestone.amountCents,
          idempotencyKey: `seed:release:${milestone.id}`,
          businessReference: `escrow:${escrow.reference}:milestone:${milestone.id}:release`,
          actorId: escrow.buyerId!,
          sourceCommand: "seed_backfill",
          createdAt: milestone.releasedAt ?? milestone.updatedAt,
        },
      });
    }
  }

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
