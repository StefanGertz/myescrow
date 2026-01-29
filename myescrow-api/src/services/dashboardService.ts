import type { Prisma, PrismaClient } from "@prisma/client";
import { buildEscrowReference, buildTimelineId } from "../utils/id";
import { formatAmountWithSuffix, formatCurrencyFromCents, dollarsToCents } from "../utils/currency";
import { AppError } from "../utils/errors";
import { getNextSequenceValue } from "./sequenceService";

export type SummaryMetric = {
  id: string;
  label: string;
  value: string;
  meta: string;
};

export type EscrowResponse = {
  id: string;
  counterpart: string;
  amount: string;
  stage: string;
  due: string;
  status: string;
  counterpartyApproved: boolean;
};

export type DisputeResponse = {
  id: string;
  title: string;
  owner: string;
  amount: string;
  updated: string;
  priority: string;
};

export type TimelineResponse = {
  id: string;
  title: string;
  meta: string;
  time: string;
  status: string;
};

const statusWeight = (status: string) => (status === "warning" ? 0 : 1);

function mapEscrow(record: { reference: string; counterpart: string; amountCents: number; stage: string; dueDescription: string; status: string; counterpartyApproved: boolean; }): EscrowResponse {
  return {
    id: record.reference,
    counterpart: record.counterpart,
    amount: formatCurrencyFromCents(record.amountCents),
    stage: record.stage,
    due: record.dueDescription,
    status: record.status,
    counterpartyApproved: record.counterpartyApproved,
  };
}

export async function getOverview(prisma: PrismaClient, userId: string) {
  const [escrows, disputes, timeline] = await Promise.all([
    prisma.escrow.findMany({ where: { ownerId: userId } }),
    prisma.dispute.findMany({ where: { ownerId: userId, status: "open" } }),
    prisma.timelineEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
  ]);

  const heldTotal = escrows.reduce((sum, escrow) => sum + escrow.amountCents, 0);
  const releasesScheduled = escrows
    .filter((escrow) => escrow.counterpartyApproved)
    .reduce((sum, escrow) => sum + escrow.amountCents, 0);
  const warningCount = escrows.filter((escrow) => escrow.status === "warning").length;
  const uniqueCounterparts = new Set(escrows.map((escrow) => escrow.counterpart)).size;

  const summaryMetrics: SummaryMetric[] = [
    {
      id: "held",
      label: "Held in Escrow",
      value: formatCurrencyFromCents(heldTotal),
      meta: `${escrows.length} active contracts`,
    },
    {
      id: "release",
      label: "Releases scheduled",
      value: formatCurrencyFromCents(releasesScheduled),
      meta: `${escrows.filter((escrow) => escrow.counterpartyApproved).length} approvals ready`,
    },
    {
      id: "disputes",
      label: "Disputes open",
      value: `${disputes.length} cases`,
      meta: warningCount > 0 ? `${warningCount} contracts need attention` : "All contracts on track",
    },
    {
      id: "verified",
      label: "Verified payers",
      value: `${uniqueCounterparts} teams`,
      meta: "Live counterparties",
    },
  ];

  return {
    summaryMetrics,
    activeEscrows: escrows
      .filter((escrow) => escrow.status === "success" || escrow.status === "warning")
      .sort((a, b) => statusWeight(a.status) - statusWeight(b.status) || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 5)
      .map(mapEscrow),
    timelineEvents: timeline.map((event) => ({
      id: event.id,
      title: event.title,
      meta: event.meta,
      time: event.timeLabel,
      status: event.status,
    } satisfies TimelineResponse)),
  };
}

export async function listEscrows(prisma: PrismaClient, userId: string): Promise<EscrowResponse[]> {
  const records = await prisma.escrow.findMany({
    where: { ownerId: userId },
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
  return records.map(mapEscrow);
}

type CreateEscrowInput = {
  title: string;
  counterpart: string;
  amount: number;
  category?: string | undefined;
  description?: string | undefined;
};

export async function createEscrow(prisma: PrismaClient, userId: string, data: CreateEscrowInput) {
  const amountInCents = dollarsToCents(data.amount);
  return prisma.$transaction(async (tx) => {
    const sequence = await getNextSequenceValue(tx, "escrow", 650);
    const reference = buildEscrowReference(sequence);
    const escrow = await tx.escrow.create({
      data: {
        reference,
        ownerId: userId,
        title: data.title,
        counterpart: data.counterpart,
        amountCents: amountInCents,
        stage: data.category ? `${data.category} milestone` : "Initial milestone",
        dueDescription: "Awaiting approval",
        status: "warning",
        counterpartyApproved: false,
        category: data.category ?? null,
        description: data.description ?? null,
      },
    });
    const timelineId = buildTimelineId(await getNextSequenceValue(tx, "timeline", 1));
    await tx.timelineEvent.create({
      data: {
        id: timelineId,
        userId,
        title: `${data.counterpart} escrow drafted`,
        meta: `${data.title} created`,
        timeLabel: "Just now",
        status: "attention",
      },
    });
    return escrow;
  });
}

export async function updateEscrowState(prisma: PrismaClient, userId: string, reference: string, data: Partial<{ status: string; counterpartyApproved: boolean; dueDescription: string; stage: string; }>) {
  const escrow = await prisma.escrow.findUnique({ where: { reference } });
  if (!escrow || escrow.ownerId !== userId) {
    throw new AppError("Escrow not found.", 404);
  }
  return prisma.escrow.update({
    where: { id: escrow.id },
    data,
  });
}

export async function listDisputes(prisma: PrismaClient, userId: string): Promise<DisputeResponse[]> {
  const disputes = await prisma.dispute.findMany({ where: { ownerId: userId, status: "open" } });
  return disputes.map((dispute) => ({
    id: dispute.reference,
    title: dispute.title,
    owner: dispute.ownerTeam,
    amount: formatAmountWithSuffix(dispute.amountCents),
    updated: dispute.updatedLabel,
    priority: dispute.priority,
  }));
}

export async function updateDispute(prisma: PrismaClient, userId: string, reference: string, data: Prisma.DisputeUpdateInput) {
  const dispute = await prisma.dispute.findUnique({ where: { reference } });
  if (!dispute || dispute.ownerId !== userId) {
    throw new AppError("Dispute not found.", 404);
  }
  return prisma.dispute.update({
    where: { id: dispute.id },
    data,
  });
}

export async function listNotifications(prisma: PrismaClient, userId: string) {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return notifications.map((notification) => ({
    id: notification.id,
    label: notification.label,
    detail: notification.detail,
    meta: notification.meta,
    txId: notification.txId ?? undefined,
  }));
}

export async function listWalletTransactions(prisma: PrismaClient, userId: string, limit = 10) {
  const transactions = await prisma.walletTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return transactions.map((tx) => ({
    id: tx.id,
    amount: formatCurrencyFromCents(Math.abs(tx.amountCents)),
    type: tx.type,
    direction: tx.amountCents >= 0 ? "credit" : "debit",
    createdAt: tx.createdAt.toISOString(),
  }));
}

export async function recordWalletTransaction(prisma: PrismaClient, userId: string, amountCents: number, type: string) {
  await prisma.walletTransaction.create({
    data: {
      userId,
      amountCents,
      type,
    },
  });
}

export async function addTimelineEvent(prisma: PrismaClient, userId: string, data: { title: string; meta: string; status: string; timeLabel?: string }) {
  const timelineId = buildTimelineId(await getNextSequenceValue(prisma, "timeline", 1));
  await prisma.timelineEvent.create({
    data: {
      id: timelineId,
      userId,
      title: data.title,
      meta: data.meta,
      status: data.status,
      timeLabel: data.timeLabel ?? "Just now",
    },
  });
}
