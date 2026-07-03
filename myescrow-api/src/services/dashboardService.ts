import type { Prisma, PrismaClient } from "@prisma/client";
import { buildEscrowReference, buildNotificationId, buildTimelineId } from "../utils/id";
import { formatAmountWithSuffix, formatCurrencyFromCents, dollarsToCents } from "../utils/currency";
import { AppError } from "../utils/errors";
import { getNextSequenceValue } from "./sequenceService";
import { normalizeEmail } from "./userService";

export type SummaryMetric = {
  id: string;
  label: string;
  value: string;
  meta: string;
};

export type EscrowMilestoneResponse = {
  id: number;
  title: string;
  amount: string;
  status: string;
  description?: string;
  releasedAt?: string;
  rejectedAt?: string;
};

export type EscrowResponse = {
  escrowId: number;
  id: string;
  title: string;
  description?: string;
  counterpart: string;
  amount: string;
  stage: string;
  due: string;
  status: string;
  counterpartyApproved: boolean;
  lifecycleStatus: string;
  fundingStatus: string;
  creatorRole: "buyer" | "seller";
  createdAt: string;
  approvedAt?: string;
  buyerSignatureDataUrl?: string;
  sellerSignatureDataUrl?: string;
  role: "buyer" | "seller";
  isOwner: boolean;
  buyer: { id: string; name: string; email: string };
  seller: { id: string; name: string; email: string };
  milestones: EscrowMilestoneResponse[];
};

type EscrowInvitationStatus = "existing_user" | "signup_required" | "verification_required";

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

type EscrowWithRelations = Prisma.EscrowGetPayload<{
  include: {
    owner: true;
    buyer: true;
    seller: true;
    milestones: { orderBy: { orderIndex: "asc" } };
  };
}>;

type CreateEscrowInput = {
  title: string;
  counterpart: string;
  counterpartyEmail: string;
  amount: number;
  creatorRole: "buyer" | "seller";
  category?: string | undefined;
  description?: string | undefined;
  signatureDataUrl?: string | undefined;
  milestones?: Array<{
    title: string;
    amount: number;
    description?: string | undefined;
  }>;
};

type MilestoneActionResult = {
  escrow: EscrowWithRelations;
  milestone: EscrowWithRelations["milestones"][number];
};

const visibleEscrowWhere = (userId: string): Prisma.EscrowWhereInput => ({
  OR: [{ ownerId: userId }, { buyerId: userId }, { sellerId: userId }],
});

const includeEscrowRelations = {
  owner: true,
  buyer: true,
  seller: true,
  milestones: { orderBy: { orderIndex: "asc" as const } },
};

function statusWeight(status: string) {
  return status === "warning" ? 0 : 1;
}

function getEscrowRole(record: Pick<EscrowWithRelations, "buyerId" | "sellerId">, userId: string) {
  return record.buyerId === userId ? "buyer" : "seller";
}

function getCounterpartName(record: EscrowWithRelations, userId: string) {
  if (record.buyerId === userId) {
    return record.seller?.name ?? record.counterpart;
  }
  if (record.sellerId === userId) {
    return record.buyer?.name ?? record.counterpart;
  }
  return record.counterpart;
}

function requireBuyerId(record: Pick<EscrowWithRelations, "buyerId">) {
  if (!record.buyerId) {
    throw new AppError("Buyer has not joined this escrow yet.", 400);
  }
  return record.buyerId;
}

function requireSellerId(record: Pick<EscrowWithRelations, "sellerId">) {
  if (!record.sellerId) {
    throw new AppError("Seller has not joined this escrow yet.", 400);
  }
  return record.sellerId;
}

function deriveStage(record: EscrowWithRelations) {
  if (record.lifecycleStatus === "pending_counterparty_signup") {
    return "Invitation pending";
  }
  if (record.lifecycleStatus === "pending_approval") {
    return "Approval pending";
  }
  if (record.lifecycleStatus === "rejected") {
    return "Rejected";
  }
  if (record.lifecycleStatus === "funding_pending") {
    return "Funding pending";
  }
  if (record.lifecycleStatus === "funded") {
    if (record.milestones.some((milestone) => milestone.status === "rejected")) {
      return "Milestone attention";
    }
    return record.milestones.some((milestone) => milestone.status === "pending")
      ? "Milestones active"
      : "Funded";
  }
  if (record.lifecycleStatus === "completed") {
    return "Released";
  }
  if (record.lifecycleStatus === "cancelled") {
    return "Cancelled";
  }
  return record.stage;
}

function deriveDueDescription(record: EscrowWithRelations) {
  if (record.lifecycleStatus === "pending_counterparty_signup") {
    return `Waiting for ${record.counterpart} to create and verify an account`;
  }
  if (record.lifecycleStatus === "pending_approval") {
    return `Waiting for ${record.counterpart} to approve`;
  }
  if (record.lifecycleStatus === "rejected") {
    return `${record.counterpart} rejected the agreement`;
  }
  if (record.lifecycleStatus === "funding_pending") {
    return "Buyer funding required";
  }
  if (record.lifecycleStatus === "funded") {
    const rejectedMilestones = record.milestones.filter((milestone) => milestone.status === "rejected").length;
    if (rejectedMilestones > 0) {
      return `${rejectedMilestones} milestone(s) need revision`;
    }
    const pendingMilestones = record.milestones.filter((milestone) => milestone.status === "pending").length;
    return pendingMilestones > 0 ? `${pendingMilestones} milestone(s) pending` : "Funded";
  }
  if (record.lifecycleStatus === "completed") {
    return "All funds released";
  }
  if (record.lifecycleStatus === "cancelled") {
    return "Escrow cancelled";
  }
  return record.dueDescription;
}

function mapEscrow(record: EscrowWithRelations, userId: string): EscrowResponse {
  const buyer = record.buyer ?? {
    id: "pending-buyer",
    name: record.creatorRole === "seller" ? record.counterpart : "Buyer pending signup",
    email: record.creatorRole === "seller" ? record.counterpartyEmail : "pending@myescrow.local",
  };
  const seller = record.seller ?? {
    id: "pending-seller",
    name: record.creatorRole === "buyer" ? record.counterpart : "Seller pending signup",
    email: record.creatorRole === "buyer" ? record.counterpartyEmail : "pending@myescrow.local",
  };

  return {
    escrowId: record.id,
    id: record.reference,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    counterpart: getCounterpartName(record, userId),
    amount: formatCurrencyFromCents(record.amountCents),
    stage: deriveStage(record),
    due: deriveDueDescription(record),
    status: record.status,
    counterpartyApproved: record.counterpartyApproved,
    lifecycleStatus: record.lifecycleStatus,
    fundingStatus: record.fundingStatus,
    creatorRole: record.creatorRole as "buyer" | "seller",
    createdAt: record.createdAt.toISOString(),
    ...(record.approvedAt ? { approvedAt: record.approvedAt.toISOString() } : {}),
    ...(record.creatorRole === "buyer"
      ? {
          ...(record.creatorSignatureDataUrl
            ? { buyerSignatureDataUrl: record.creatorSignatureDataUrl }
            : {}),
          ...(record.counterpartySignatureDataUrl
            ? { sellerSignatureDataUrl: record.counterpartySignatureDataUrl }
            : {}),
        }
      : {
          ...(record.counterpartySignatureDataUrl
            ? { buyerSignatureDataUrl: record.counterpartySignatureDataUrl }
            : {}),
          ...(record.creatorSignatureDataUrl
            ? { sellerSignatureDataUrl: record.creatorSignatureDataUrl }
            : {}),
        }),
    role: getEscrowRole(record, userId),
    isOwner: record.ownerId === userId,
    buyer: {
      id: buyer.id,
      name: buyer.name,
      email: buyer.email,
    },
    seller: {
      id: seller.id,
      name: seller.name,
      email: seller.email,
    },
    milestones: record.milestones.map((milestone) => ({
      id: milestone.id,
      title: milestone.title,
      amount: formatCurrencyFromCents(milestone.amountCents),
      status: milestone.status,
      ...(milestone.description ? { description: milestone.description } : {}),
      ...(milestone.releasedAt ? { releasedAt: milestone.releasedAt.toISOString() } : {}),
      ...(milestone.rejectedAt ? { rejectedAt: milestone.rejectedAt.toISOString() } : {}),
    })),
  };
}

async function createNotification(
  tx: Prisma.TransactionClient,
  userId: string,
  label: string,
  detail: string,
  meta: string,
  escrowId?: number,
) {
  const notificationId = buildNotificationId(await getNextSequenceValue(tx, "notification", 1));
  await tx.notification.create({
    data: {
      id: notificationId,
      userId,
      label,
      detail,
      meta,
      txId: escrowId ?? null,
    },
  });
}

async function createTimeline(
  tx: Prisma.TransactionClient,
  userId: string,
  title: string,
  meta: string,
  status: string,
  timeLabel = "Just now",
) {
  const timelineId = buildTimelineId(await getNextSequenceValue(tx, "timeline", 1));
  await tx.timelineEvent.create({
    data: {
      id: timelineId,
      userId,
      title,
      meta,
      status,
      timeLabel,
    },
  });
}

async function findEscrowForUser(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await prisma.escrow.findFirst({
    where: {
      reference,
      ...visibleEscrowWhere(userId),
    },
    include: includeEscrowRelations,
  });
  if (!escrow) {
    throw new AppError("Escrow not found.", 404);
  }
  return escrow;
}

function getMilestoneById(
  escrow: EscrowWithRelations,
  milestoneId: number,
) {
  const milestone = escrow.milestones.find((item) => item.id === milestoneId);
  if (!milestone) {
    throw new AppError("Milestone not found.", 404);
  }
  return milestone;
}

function getEscrowStateFromMilestones(milestones: EscrowWithRelations["milestones"]) {
  const remainingPending = milestones.filter((milestone) => milestone.status === "pending").length;
  const rejectedCount = milestones.filter((milestone) => milestone.status === "rejected").length;
  const allReleased = milestones.length > 0 && milestones.every((milestone) => milestone.status === "released");

  if (allReleased) {
    return {
      lifecycleStatus: "completed",
      stage: "Released",
      dueDescription: "All funds released",
      status: "success",
    } as const;
  }

  if (rejectedCount > 0) {
    return {
      lifecycleStatus: "funded",
      stage: "Milestone attention",
      dueDescription: `${rejectedCount} milestone(s) need revision`,
      status: "warning",
    } as const;
  }

  return {
    lifecycleStatus: "funded",
    stage: "Milestones active",
    dueDescription: `${remainingPending} milestone(s) pending`,
    status: "success",
  } as const;
}

export async function getOverview(prisma: PrismaClient, userId: string) {
  const [user, escrows, disputes, timeline] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.escrow.findMany({
      where: visibleEscrowWhere(userId),
      include: includeEscrowRelations,
    }),
    prisma.dispute.findMany({ where: { ownerId: userId, status: "open" } }),
    prisma.timelineEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
  ]);

  const activeEscrows = escrows.filter((escrow) => !["cancelled", "completed"].includes(escrow.lifecycleStatus));
  const heldTotal = activeEscrows.reduce((sum, escrow) => sum + escrow.amountCents, 0);
  const releasesScheduled = escrows
    .filter((escrow) => escrow.lifecycleStatus === "funded")
    .reduce((sum, escrow) => sum + escrow.amountCents, 0);
  const warningCount = escrows.filter((escrow) => escrow.status === "warning").length;
  const uniqueCounterparts = new Set(escrows.map((escrow) => getCounterpartName(escrow, userId))).size;

  const summaryMetrics: SummaryMetric[] = [
    {
      id: "held",
      label: "Held in Escrow",
      value: formatCurrencyFromCents(heldTotal),
      meta: `${activeEscrows.length} shared contracts`,
    },
    {
      id: "release",
      label: "Releases scheduled",
      value: formatCurrencyFromCents(releasesScheduled),
      meta: `${escrows.filter((escrow) => escrow.lifecycleStatus === "funded").length} funded escrows`,
    },
    {
      id: "disputes",
      label: "Disputes open",
      value: `${disputes.length} cases`,
      meta: warningCount > 0 ? `${warningCount} contracts need attention` : "All contracts on track",
    },
    {
      id: "verified",
      label: "Verified counterparties",
      value: `${uniqueCounterparts} teams`,
      meta: "Live shared escrows",
    },
  ];

  return {
    walletBalance: formatCurrencyFromCents(user?.walletBalanceCents ?? 0),
    summaryMetrics,
    activeEscrows: activeEscrows
      .sort((a, b) => statusWeight(a.status) - statusWeight(b.status) || b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 5)
      .map((escrow) => mapEscrow(escrow, userId)),
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
    where: visibleEscrowWhere(userId),
    include: includeEscrowRelations,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
  return records.map((record) => mapEscrow(record, userId));
}

export async function createEscrow(prisma: PrismaClient, userId: string, data: CreateEscrowInput) {
  const amountInCents = dollarsToCents(data.amount);
  const milestoneInputs = data.milestones?.length
    ? data.milestones
    : [{ title: data.title, amount: data.amount, description: data.description }];
  const milestoneTotal = milestoneInputs.reduce((sum, milestone) => sum + milestone.amount, 0);

  if (Math.abs(milestoneTotal - data.amount) > 0.01) {
    throw new AppError("Milestone total must match the escrow amount.", 400);
  }

  const owner = await prisma.user.findUnique({ where: { id: userId } });
  if (!owner) {
    throw new AppError("User not found.", 404);
  }

  const normalizedCounterpartyEmail = normalizeEmail(data.counterpartyEmail);
  const counterpartyUser = await prisma.user.findUnique({
    where: { email: normalizedCounterpartyEmail },
  });
  if (counterpartyUser?.id === userId) {
    throw new AppError("You cannot create an escrow with your own account.", 400);
  }

  const invitationStatus: EscrowInvitationStatus = !counterpartyUser
    ? "signup_required"
    : counterpartyUser.emailVerified
      ? "existing_user"
      : "verification_required";
  const counterpartyReady = invitationStatus === "existing_user";
  const buyerId = data.creatorRole === "buyer" ? userId : counterpartyReady ? counterpartyUser!.id : null;
  const sellerId = data.creatorRole === "seller" ? userId : counterpartyReady ? counterpartyUser!.id : null;
  const counterpartName = data.counterpart.trim() || counterpartyUser?.name || normalizedCounterpartyEmail;

  const result = await prisma.$transaction(async (tx) => {
    const sequence = await getNextSequenceValue(tx, "escrow", 650);
    const reference = buildEscrowReference(sequence);
    const escrowData: Prisma.EscrowUncheckedCreateInput = {
        reference,
        ownerId: userId,
        buyerId,
        sellerId,
        creatorRole: data.creatorRole,
        counterpartyEmail: normalizedCounterpartyEmail,
        title: data.title,
        counterpart: counterpartName,
        amountCents: amountInCents,
        stage: counterpartyReady ? "Approval pending" : "Invitation pending",
        dueDescription: counterpartyReady
          ? `Waiting for ${counterpartName} to approve`
          : `Waiting for ${counterpartName} to create and verify an account`,
        status: "warning",
        counterpartyApproved: false,
        lifecycleStatus: counterpartyReady ? "pending_approval" : "pending_counterparty_signup",
        fundingStatus: "not_funded",
        category: data.category ?? null,
        description: data.description ?? null,
        creatorSignatureDataUrl: data.signatureDataUrl ?? null,
        milestones: {
          create: milestoneInputs.map((milestone, index) => ({
            title: milestone.title.trim(),
            description: milestone.description?.trim() || null,
            amountCents: dollarsToCents(milestone.amount),
            orderIndex: index,
          })),
        },
      };
    const escrow = await tx.escrow.create({
      data: escrowData,
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      userId,
      `${counterpartName} escrow drafted`,
      `${data.title} created`,
      "attention",
    );
    await createNotification(
      tx,
      userId,
      "Escrow created",
      counterpartyReady
        ? `${counterpartName} has been invited to review ${data.title}.`
        : `${counterpartName} must finish signup before the escrow can be reviewed.`,
      "Just now",
      escrow.id,
    );

    if (counterpartyUser && counterpartyReady) {
      await createTimeline(
        tx,
        counterpartyUser.id,
        `${owner.name} invited you to escrow`,
        `${data.title} is awaiting your approval`,
        "attention",
      );
      await createNotification(
        tx,
        counterpartyUser.id,
        "Escrow approval requested",
        `${owner.name} invited you to review ${data.title}.`,
        "Just now",
        escrow.id,
      );
    }

    return { escrow, owner, counterpartyUser, invitationStatus, invitedEmail: normalizedCounterpartyEmail };
  });

  return result;
}

export async function claimPendingEscrowsForUser(prisma: PrismaClient, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.emailVerified) {
    return { claimedCount: 0 };
  }

  const pendingEscrows = await prisma.escrow.findMany({
    where: {
      counterpartyEmail: user.email,
      lifecycleStatus: "pending_counterparty_signup",
    },
    include: includeEscrowRelations,
  });

  if (pendingEscrows.length === 0) {
    return { claimedCount: 0 };
  }

  await prisma.$transaction(async (tx) => {
    for (const escrow of pendingEscrows) {
      const isSellerInvite = escrow.creatorRole === "buyer";
      const updated = await tx.escrow.update({
        where: { id: escrow.id },
        data: {
          buyerId: isSellerInvite ? escrow.buyerId : user.id,
          sellerId: isSellerInvite ? user.id : escrow.sellerId,
          lifecycleStatus: "pending_approval",
          stage: "Approval pending",
          dueDescription: `Waiting for ${escrow.counterpart} to approve`,
          status: "warning",
        },
        include: includeEscrowRelations,
      });

      await createTimeline(
        tx,
        escrow.ownerId,
        `${user.name} joined ${updated.reference}`,
        `${updated.title} is now awaiting approval`,
        "attention",
      );
      await createTimeline(
        tx,
        user.id,
        `${updated.reference} is ready for review`,
        `${updated.title} is awaiting your approval`,
        "attention",
      );
      await createNotification(
        tx,
        escrow.ownerId,
        "Counterparty joined",
        `${user.name} finished onboarding for ${updated.title}.`,
        "Just now",
        updated.id,
      );
      await createNotification(
        tx,
        user.id,
        "Escrow approval requested",
        `${updated.owner.name} invited you to review ${updated.title}.`,
        "Just now",
        updated.id,
      );
    }
  });

  return { claimedCount: pendingEscrows.length };
}

export async function approveEscrow(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  signatureDataUrl?: string,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId === userId) {
    throw new AppError("Only the invited counterparty can approve this escrow.", 403);
  }
  if (escrow.lifecycleStatus !== "pending_approval") {
    throw new AppError("This escrow is not awaiting approval.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        counterpartyApproved: true,
        lifecycleStatus: "funding_pending",
        stage: "Funding pending",
        dueDescription: "Buyer funding required",
        status: "warning",
        approvedAt: new Date(),
        counterpartySignatureDataUrl: signatureDataUrl ?? null,
      },
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      escrow.ownerId,
      `${updated.counterpart} approved ${updated.reference}`,
      "Buyer can now fund the escrow",
      "attention",
    );
    await createTimeline(
      tx,
      userId,
      `You approved ${updated.reference}`,
      "Waiting for buyer funding",
      "attention",
    );
    await createNotification(
      tx,
      escrow.ownerId,
      "Escrow approved",
      `${updated.counterpart} approved ${updated.title}. Buyer funding is next.`,
      "Just now",
      updated.id,
    );

    return updated;
  });
}

export async function rejectEscrow(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId === userId) {
    throw new AppError("Only the invited counterparty can reject this escrow.", 403);
  }
  if (escrow.lifecycleStatus !== "pending_approval") {
    throw new AppError("This escrow is not awaiting approval.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        counterpartyApproved: false,
        lifecycleStatus: "rejected",
        stage: "Rejected",
        dueDescription: `${escrow.counterpart} rejected the agreement`,
        status: "warning",
        rejectedAt: new Date(),
      },
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      escrow.ownerId,
      `${updated.counterpart} rejected ${updated.reference}`,
      "Review terms and resend if needed",
      "attention",
    );
    await createNotification(
      tx,
      escrow.ownerId,
      "Escrow rejected",
      `${updated.counterpart} rejected ${updated.title}.`,
      "Just now",
      updated.id,
    );

    return updated;
  });
}

export async function cancelEscrow(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) {
    throw new AppError("Only the creator can cancel this escrow.", 403);
  }
  if (escrow.lifecycleStatus === "completed") {
    throw new AppError("Completed escrows cannot be cancelled.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: "cancelled",
        stage: "Cancelled",
        dueDescription: "Escrow cancelled",
        status: "warning",
        cancelledAt: new Date(),
      },
      include: includeEscrowRelations,
    });

    const counterpartId = escrow.ownerId === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
    if (counterpartId) {
      const cancelledByName = updated.ownerId === updated.buyerId
        ? updated.buyer?.name ?? updated.owner.name
        : updated.seller?.name ?? updated.owner.name;
      await createNotification(
        tx,
        counterpartId,
        "Escrow cancelled",
        `${updated.title} was cancelled by ${cancelledByName}.`,
        "Just now",
        updated.id,
      );
    }

    return updated;
  });
}

export async function fundEscrow(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const buyerId = requireBuyerId(escrow);
  if (buyerId !== userId) {
    throw new AppError("Only the buyer can fund this escrow.", 403);
  }
  if (escrow.lifecycleStatus !== "funding_pending") {
    throw new AppError("This escrow is not ready for funding.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const buyer = await tx.user.findUnique({ where: { id: userId } });
    if (!buyer) {
      throw new AppError("Buyer not found.", 404);
    }
    if (buyer.walletBalanceCents < escrow.amountCents) {
      throw new AppError("Insufficient wallet balance.", 400);
    }

    await tx.user.update({
      where: { id: buyer.id },
      data: { walletBalanceCents: buyer.walletBalanceCents - escrow.amountCents },
    });
    await tx.walletTransaction.create({
      data: {
        userId: buyer.id,
        amountCents: -escrow.amountCents,
        type: "FUND",
      },
    });

    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: "funded",
        fundingStatus: "funded",
        stage: "Milestones active",
        dueDescription: "Funds secured in escrow",
        status: "success",
        fundedAt: new Date(),
      },
      include: includeEscrowRelations,
    });

    const sellerId = requireSellerId(updated);
    await createTimeline(tx, buyer.id, `${updated.reference} funded`, "Funds secured in escrow", "funding");
    await createTimeline(tx, sellerId, `${updated.reference} funded`, "Work can begin", "funding");
    await createNotification(
      tx,
      sellerId,
      "Escrow funded",
      `${updated.title} is funded and ready for milestone work.`,
      "Just now",
      updated.id,
    );

    return updated;
  });
}

export async function releaseEscrow(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const buyerId = requireBuyerId(escrow);
  if (buyerId !== userId) {
    throw new AppError("Only the buyer can release this escrow.", 403);
  }
  if (escrow.lifecycleStatus !== "funded") {
    throw new AppError("Only funded escrows can be released.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const seller = await tx.user.findUnique({ where: { id: requireSellerId(escrow) } });
    if (!seller) {
      throw new AppError("Seller not found.", 404);
    }

    await tx.user.update({
      where: { id: seller.id },
      data: { walletBalanceCents: seller.walletBalanceCents + escrow.amountCents },
    });
    await tx.walletTransaction.create({
      data: {
        userId: seller.id,
        amountCents: escrow.amountCents,
        type: "RELEASE",
      },
    });
    await tx.escrowMilestone.updateMany({
      where: {
        escrowId: escrow.id,
        status: "pending",
      },
      data: {
        status: "released",
        releasedAt: new Date(),
      },
    });

    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: "completed",
        stage: "Released",
        dueDescription: "All funds released",
        status: "success",
      },
      include: includeEscrowRelations,
    });

    await createTimeline(tx, seller.id, `Release approved for ${updated.reference}`, `${updated.title} payout sent`, "released");
    await createTimeline(tx, requireBuyerId(updated), `Release approved for ${updated.reference}`, `${updated.counterpart} payout sent`, "released");
    await createNotification(
      tx,
      seller.id,
      "Escrow payout released",
      `${updated.title} funds were released to your wallet.`,
      "Just now",
      updated.id,
    );

    return updated;
  });
}

export async function approveMilestone(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
): Promise<MilestoneActionResult> {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const buyerId = requireBuyerId(escrow);
  if (buyerId !== userId) {
    throw new AppError("Only the buyer can approve milestone releases.", 403);
  }
  if (escrow.lifecycleStatus !== "funded") {
    throw new AppError("Milestones can only be approved after funding.", 400);
  }

  const targetMilestone = getMilestoneById(escrow, milestoneId);
  if (targetMilestone.status !== "pending") {
    throw new AppError("Only pending milestones can be approved.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const seller = await tx.user.findUnique({ where: { id: requireSellerId(escrow) } });
    if (!seller) {
      throw new AppError("Seller not found.", 404);
    }

    const releasedAt = new Date();
    const milestone = await tx.escrowMilestone.update({
      where: { id: milestoneId },
      data: {
        status: "released",
        releasedAt,
        rejectedAt: null,
      },
    });

    await tx.user.update({
      where: { id: seller.id },
      data: { walletBalanceCents: seller.walletBalanceCents + milestone.amountCents },
    });
    await tx.walletTransaction.create({
      data: {
        userId: seller.id,
        amountCents: milestone.amountCents,
        type: "RELEASE",
      },
    });

    const milestones = await tx.escrowMilestone.findMany({
      where: { escrowId: escrow.id },
      orderBy: { orderIndex: "asc" },
    });
    const state = getEscrowStateFromMilestones(milestones);
    const updatedEscrow = await tx.escrow.update({
      where: { id: escrow.id },
      data: state,
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      seller.id,
      `Milestone released for ${updatedEscrow.reference}`,
      `${milestone.title} paid out`,
      "released",
    );
    await createTimeline(
      tx,
      requireBuyerId(updatedEscrow),
      `You released ${milestone.title}`,
      `${formatCurrencyFromCents(milestone.amountCents)} sent to ${updatedEscrow.seller?.name ?? updatedEscrow.counterpart}`,
      "released",
    );
    await createNotification(
      tx,
      seller.id,
      "Milestone released",
      `${milestone.title} funds were released to your wallet.`,
      "Just now",
      updatedEscrow.id,
    );

    return {
      escrow: updatedEscrow,
      milestone: updatedEscrow.milestones.find((item) => item.id === milestoneId)!,
    };
  });
}

export async function rejectMilestone(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
): Promise<MilestoneActionResult> {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const buyerId = requireBuyerId(escrow);
  if (buyerId !== userId) {
    throw new AppError("Only the buyer can reject milestones.", 403);
  }
  if (escrow.lifecycleStatus !== "funded") {
    throw new AppError("Milestones can only be reviewed after funding.", 400);
  }

  const targetMilestone = getMilestoneById(escrow, milestoneId);
  if (targetMilestone.status !== "pending") {
    throw new AppError("Only pending milestones can be rejected.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const rejectedAt = new Date();
    await tx.escrowMilestone.update({
      where: { id: milestoneId },
      data: {
        status: "rejected",
        rejectedAt,
      },
    });

    const milestones = await tx.escrowMilestone.findMany({
      where: { escrowId: escrow.id },
      orderBy: { orderIndex: "asc" },
    });
    const state = getEscrowStateFromMilestones(milestones);
    const updatedEscrow = await tx.escrow.update({
      where: { id: escrow.id },
      data: state,
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      requireSellerId(updatedEscrow),
      `Milestone rejected for ${updatedEscrow.reference}`,
      `${targetMilestone.title} needs revision`,
      "attention",
    );
    await createTimeline(
      tx,
      requireBuyerId(updatedEscrow),
      `You rejected ${targetMilestone.title}`,
      "Seller needs to revise this milestone",
      "attention",
    );
    await createNotification(
      tx,
      requireSellerId(updatedEscrow),
      "Milestone needs revision",
      `${targetMilestone.title} was rejected and needs updates.`,
      "Just now",
      updatedEscrow.id,
    );

    return {
      escrow: updatedEscrow,
      milestone: updatedEscrow.milestones.find((item) => item.id === milestoneId)!,
    };
  });
}

export async function resubmitMilestone(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
): Promise<MilestoneActionResult> {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const sellerId = requireSellerId(escrow);
  if (sellerId !== userId) {
    throw new AppError("Only the seller can resubmit rejected milestones.", 403);
  }
  if (escrow.lifecycleStatus !== "funded") {
    throw new AppError("Milestones can only be resubmitted after funding.", 400);
  }

  const targetMilestone = getMilestoneById(escrow, milestoneId);
  if (targetMilestone.status !== "rejected") {
    throw new AppError("Only rejected milestones can be resubmitted.", 400);
  }

  return prisma.$transaction(async (tx) => {
    await tx.escrowMilestone.update({
      where: { id: milestoneId },
      data: {
        status: "pending",
        rejectedAt: null,
      },
    });

    const milestones = await tx.escrowMilestone.findMany({
      where: { escrowId: escrow.id },
      orderBy: { orderIndex: "asc" },
    });
    const state = getEscrowStateFromMilestones(milestones);
    const updatedEscrow = await tx.escrow.update({
      where: { id: escrow.id },
      data: state,
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      requireBuyerId(updatedEscrow),
      `Milestone resubmitted for ${updatedEscrow.reference}`,
      `${targetMilestone.title} is ready for review again`,
      "attention",
    );
    await createTimeline(
      tx,
      requireSellerId(updatedEscrow),
      `You resubmitted ${targetMilestone.title}`,
      "Waiting for buyer review",
      "attention",
    );
    await createNotification(
      tx,
      requireBuyerId(updatedEscrow),
      "Milestone resubmitted",
      `${targetMilestone.title} was resubmitted and is ready for review.`,
      "Just now",
      updatedEscrow.id,
    );

    return {
      escrow: updatedEscrow,
      milestone: updatedEscrow.milestones.find((item) => item.id === milestoneId)!,
    };
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
    createdAt: notification.createdAt.toISOString(),
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
