import type { Prisma, PrismaClient } from "@prisma/client";
import { buildEscrowReference, buildNotificationId, buildTimelineId } from "../utils/id";
import { formatAmountWithSuffix, formatCurrencyFromCents, dollarsToCents } from "../utils/currency";
import { AppError } from "../utils/errors";
import { getNextSequenceValue } from "./sequenceService";
import { normalizeEmail } from "./userService";
import {
  assertFundableAgreement,
  createAgreementVersion,
  lockAgreementIfFullySigned,
  signAgreementVersion,
} from "./agreementService";
import {
  markInvitationAccepted,
  queueEscrowInvitation,
} from "./invitationService";
import {
  executeIdempotentCommand,
  executeIdempotentCommandWithMetadata,
} from "./idempotencyService";
import {
  applyEscrowTransfer,
  deriveLedgerBalances,
  getEscrowLedgerBalances,
  type LedgerBalances,
} from "./moneyIntegrityService";
import {
  submitMilestoneWork,
  type MilestoneSubmissionInput,
} from "./milestoneReviewService";

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
  deadline?: string;
  requestedTitle?: string;
  requestedDescription?: string;
  requestedAmount?: string;
  requestedDeadline?: string;
  changeRequestNote?: string;
  changeRequestedAt?: string;
  releasedAt?: string;
  rejectedAt?: string;
  reviewDeadline?: string;
  reminderSentAt?: string;
  reviewOverdueAt?: string;
  submissions: Array<{
    id: number;
    submissionNumber: number;
    note?: string;
    submittedAt: string;
    reviewDeadline: string;
    submitter: { id: string; name: string };
    evidence: Array<{
      id: number;
      objectKey: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    }>;
    review?: {
      decision: string;
      reason?: string;
      reviewedAt: string;
      reviewer: { id: string; name: string };
    };
  }>;
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
  buyer: PartyResponse;
  seller: PartyResponse;
  milestones: EscrowMilestoneResponse[];
  balances: LedgerBalances;
  agreement: {
    version: number;
    status: string;
    creatorSigned: boolean;
    counterpartySigned: boolean;
    lockedAt?: string;
  } | null;
  invitation: {
    status: string;
    recipient: string;
    attemptCount: number;
    expiresAt: string;
    responseDueAt: string;
    failureReason?: string;
  } | null;
  cancellation: {
    id: string;
    mode: string;
    reason: string;
    status: string;
    requestedById: string;
    requestedAt: string;
    refundAmountCents: number;
  } | null;
};

type PartyIdentityInput =
  | { type: "individual" }
  | {
      type: "business";
      business: {
        legalName: string;
        registrationCountry: string;
        registrationNumber: string;
        registeredAddress: string;
        representativeTitle: string;
      };
    };

type PartySnapshot = {
  type: "individual" | "business";
  legalName: string;
  email: string;
  representativeName?: string;
  representativeTitle?: string;
  registrationCountry?: string;
  registrationNumber?: string;
  registeredAddress?: string;
};

type PartyResponse = {
  id: string;
  name: string;
  email: string;
  partyType: "individual" | "business";
  representativeName?: string;
  representativeTitle?: string;
  registrationCountry?: string;
  registrationNumber?: string;
  registeredAddress?: string;
};

type EscrowInvitationStatus = "existing_user" | "signup_required" | "verification_required";

export type DisputeResponse = {
  id: string;
  title: string;
  owner: string;
  amount: string;
  updated: string;
  priority: string;
  status: string;
  reason?: string;
  escrowId?: string;
  milestoneId?: number;
  amountFrozenCents: number;
  evidenceWindowEndsAt?: string;
  openedBy?: { id: string; name: string };
  resolution?: {
    proposedById: string;
    sellerCents: number;
    buyerCents: number;
    note?: string;
  };
  evidence: Array<{
    id: number;
    note?: string;
    submittedAt: string;
    submitter: { id: string; name: string };
    references: Array<{
      objectKey: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      sha256: string;
    }>;
  }>;
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
    milestones: {
      orderBy: { orderIndex: "asc" };
      include: {
        submissions: {
          orderBy: { submissionNumber: "asc" };
          include: { submitter: true; evidence: true; review: { include: { reviewer: true } } };
        };
      };
    };
    ledgerEntries: { select: { movementType: true; amountCents: true } };
    disputes: { where: { status: { in: ["open", "resolution_proposed", "resolving"] } } };
    currentAgreementVersion: { include: { signatures: true } };
    invitationDeliveries: { orderBy: { createdAt: "desc" }; take: 1 };
    cancellationRequests: { orderBy: { requestedAt: "desc" }; take: 1 };
  };
}>;

type CreateEscrowInput = {
  title: string;
  counterpartyEmail: string;
  amount: number;
  creatorRole: "buyer" | "seller";
  creatorParty: PartyIdentityInput;
  category?: string | undefined;
  description?: string | undefined;
  signatureDataUrl: string;
  milestones?: Array<{
    title: string;
    amount: number;
    description?: string | undefined;
    deadline?: string | undefined;
  }>;
};

type UpdateDraftEscrowInput = {
  title: string;
  counterpartyEmail: string;
  amount: number;
  description?: string | undefined;
  milestones?: Array<{
    title: string;
    amount: number;
    description?: string | undefined;
    deadline?: string | undefined;
  }>;
};

type ApproveEscrowInput = {
  signatureDataUrl: string;
  counterpartyParty: PartyIdentityInput;
};

type MilestoneChangeRequestInput = {
  title: string;
  description?: string | undefined;
  amount: number;
  deadline?: string | undefined;
  note?: string | undefined;
};

type MilestoneChangeReviewInput = {
  decision: "accept" | "reject";
  title?: string | undefined;
  description?: string | undefined;
  amount?: number | undefined;
  deadline?: string | null | undefined;
};

type AgreementMilestoneChangeInput = {
  milestoneId?: number | undefined;
  title: string;
  description?: string | undefined;
  amount: number;
  deadline?: string | undefined;
};

type AgreementChangeRequestInput = {
  milestones: AgreementMilestoneChangeInput[];
  note?: string | undefined;
};

type AgreementChangeReviewInput = {
  decision: "accept" | "reject";
  milestones?: AgreementMilestoneChangeInput[] | undefined;
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
  milestones: {
    orderBy: { orderIndex: "asc" as const },
    include: {
      submissions: {
        orderBy: { submissionNumber: "asc" as const },
        include: { submitter: true, evidence: true, review: { include: { reviewer: true } } },
      },
    },
  },
  ledgerEntries: { select: { movementType: true, amountCents: true } },
  disputes: { where: { status: { in: ["open", "resolution_proposed", "resolving"] as string[] } } },
  currentAgreementVersion: { include: { signatures: true } },
  invitationDeliveries: { orderBy: { createdAt: "desc" as const }, take: 1 },
  cancellationRequests: { orderBy: { requestedAt: "desc" as const }, take: 1 },
};

const PROPOSED_NEW_MILESTONE_TITLE = "__MYESCROW_PROPOSED_NEW_MILESTONE__";

const isProposedNewMilestone = (milestone: EscrowWithRelations["milestones"][number]) =>
  milestone.title === PROPOSED_NEW_MILESTONE_TITLE && milestone.amountCents === 0;

const hasPendingAgreementChanges = (escrow: Pick<EscrowWithRelations, "milestones">) =>
  escrow.milestones.some((milestone) => milestone.changeRequestedAt !== null);

function agreementTermsFromEscrow(escrow: EscrowWithRelations) {
  return {
    title: escrow.title,
    description: escrow.description,
    amountCents: escrow.amountCents,
    creatorRole: escrow.creatorRole,
    creatorParty: escrow.creatorPartySnapshot as Prisma.InputJsonValue,
    counterpartyParty: escrow.counterpartyPartySnapshot as Prisma.InputJsonValue | null,
    milestones: escrow.milestones
      .filter((milestone) => !isProposedNewMilestone(milestone))
      .map((milestone) => ({
        milestoneId: milestone.id,
        title: milestone.title,
        description: milestone.description,
        amountCents: milestone.amountCents,
        deadline: milestone.deadline?.toISOString() ?? null,
        orderIndex: milestone.orderIndex,
      })),
  };
}

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

function buildPartySnapshot(
  user: Pick<EscrowWithRelations["owner"], "name" | "email">,
  party: PartyIdentityInput,
): PartySnapshot {
  if (party.type === "individual") {
    return { type: "individual", legalName: user.name, email: user.email };
  }
  return {
    type: "business",
    legalName: party.business.legalName.trim(),
    email: user.email,
    representativeName: user.name,
    representativeTitle: party.business.representativeTitle.trim(),
  };
}

function readPartySnapshot(value: Prisma.JsonValue | null, fallback: PartySnapshot): PartySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const candidate = value as Record<string, unknown>;
  if ((candidate.type !== "individual" && candidate.type !== "business") || typeof candidate.legalName !== "string") {
    return fallback;
  }
  return candidate as PartySnapshot;
}

function partyResponse(id: string, snapshot: PartySnapshot): PartyResponse {
  return {
    id,
    name: snapshot.legalName,
    email: snapshot.email,
    partyType: snapshot.type,
    ...(snapshot.representativeName ? { representativeName: snapshot.representativeName } : {}),
    ...(snapshot.representativeTitle ? { representativeTitle: snapshot.representativeTitle } : {}),
    ...(snapshot.registrationCountry ? { registrationCountry: snapshot.registrationCountry } : {}),
    ...(snapshot.registrationNumber ? { registrationNumber: snapshot.registrationNumber } : {}),
    ...(snapshot.registeredAddress ? { registeredAddress: snapshot.registeredAddress } : {}),
  };
}

async function saveBusinessProfile(
  tx: Prisma.TransactionClient,
  userId: string,
  party: PartyIdentityInput,
) {
  if (party.type !== "business") return;
  const profile = {
    legalName: party.business.legalName,
    representativeTitle: party.business.representativeTitle,
    registrationCountry: "",
    registrationNumber: "",
    registeredAddress: "",
  };
  await tx.businessProfile.upsert({
    where: { userId },
    create: { userId, ...profile },
    update: profile,
  });
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
  if (record.lifecycleStatus === "creator_signature_required") {
    return "Creator signature required";
  }
  if (record.lifecycleStatus === "changes_requested") {
    return "Changes requested";
  }
  if (record.lifecycleStatus === "rejected") {
    return "Cancelled";
  }
  if (record.lifecycleStatus === "funding_pending") {
    return "Funding pending";
  }
  if (record.lifecycleStatus === "funded") {
    if (record.milestones.some((milestone) => milestone.status === "revision_requested")) {
      return "Milestone attention";
    }
    return record.milestones.some((milestone) => ["not_started", "submitted"].includes(milestone.status))
      ? "Milestones active"
      : "Funded";
  }
  if (record.lifecycleStatus === "completed") {
    return "Completed";
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
  if (record.lifecycleStatus === "creator_signature_required") {
    return "The creator must sign the latest agreement version";
  }
  if (record.lifecycleStatus === "changes_requested") {
    return record.ownerId === record.buyerId || record.ownerId === record.sellerId
      ? "Milestone revisions requested"
      : "Changes requested";
  }
  if (record.lifecycleStatus === "rejected") {
    return `Cancelled by ${record.counterpart}`;
  }
  if (record.lifecycleStatus === "funding_pending") {
    return "Buyer funding required";
  }
  if (record.lifecycleStatus === "funded") {
    const rejectedMilestones = record.milestones.filter((milestone) => milestone.status === "revision_requested").length;
    if (rejectedMilestones > 0) {
      return `${rejectedMilestones} milestone(s) need revision`;
    }
    const pendingMilestones = record.milestones.filter((milestone) => ["not_started", "submitted"].includes(milestone.status)).length;
    return pendingMilestones > 0 ? `${pendingMilestones} milestone(s) pending` : "Funded";
  }
  if (record.lifecycleStatus === "completed") {
    return "All funds allocated";
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
  const creatorSnapshot = readPartySnapshot(record.creatorPartySnapshot, {
    type: "individual",
    legalName: record.owner.name,
    email: record.owner.email,
  });
  const pendingCounterparty = record.creatorRole === "buyer" ? seller : buyer;
  const counterpartySnapshot = readPartySnapshot(record.counterpartyPartySnapshot, {
    type: "individual",
    legalName: pendingCounterparty.name,
    email: pendingCounterparty.email,
  });
  const buyerParty = record.creatorRole === "buyer" ? creatorSnapshot : counterpartySnapshot;
  const sellerParty = record.creatorRole === "seller" ? creatorSnapshot : counterpartySnapshot;
  const buyerResponse = partyResponse(buyer.id, buyerParty);
  const sellerResponse = partyResponse(seller.id, sellerParty);
  const agreementSigners = new Set(
    record.currentAgreementVersion?.signatures.map((signature) => signature.signerId) ?? [],
  );
  const invitation = record.invitationDeliveries[0];
  const cancellation = record.cancellationRequests[0];
  const invitationStatus = invitation
    && invitation.status !== "accepted"
    && invitation.status !== "corrected"
    && invitation.expiresAt.getTime() <= Date.now()
    ? "expired"
    : invitation?.status;

  return {
    escrowId: record.id,
    id: record.reference,
    title: record.title,
    ...(record.description ? { description: record.description } : {}),
    counterpart: getEscrowRole(record, userId) === "buyer" ? sellerResponse.name : buyerResponse.name,
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
    buyer: buyerResponse,
    seller: sellerResponse,
    balances: deriveLedgerBalances(
      record.ledgerEntries,
      record.disputes.reduce((total, dispute) => total + dispute.amountFrozenCents, 0),
    ),
    agreement: record.currentAgreementVersion
      ? {
          version: record.currentAgreementVersion.versionNumber,
          status: record.currentAgreementVersion.status,
          creatorSigned: agreementSigners.has(record.ownerId),
          counterpartySigned: agreementSigners.has(
            record.ownerId === record.buyerId ? record.sellerId ?? "" : record.buyerId ?? "",
          ),
          ...(record.currentAgreementVersion.lockedAt
            ? { lockedAt: record.currentAgreementVersion.lockedAt.toISOString() }
            : {}),
        }
      : null,
    invitation: invitation
      ? {
          status: invitationStatus ?? invitation.status,
          recipient: invitation.recipient,
          attemptCount: invitation.attemptCount,
          expiresAt: invitation.expiresAt.toISOString(),
          responseDueAt: invitation.responseDueAt.toISOString(),
          ...(invitation.failureReason ? { failureReason: invitation.failureReason } : {}),
        }
      : null,
    cancellation: cancellation
      ? {
          id: cancellation.reference,
          mode: cancellation.mode,
          reason: cancellation.reason,
          status: cancellation.status,
          requestedById: cancellation.requestedById,
          requestedAt: cancellation.requestedAt.toISOString(),
          refundAmountCents: cancellation.refundAmountCents,
        }
      : null,
    milestones: record.milestones.map((milestone) => ({
      id: milestone.id,
      title: isProposedNewMilestone(milestone) ? milestone.requestedTitle ?? "New milestone" : milestone.title,
      amount: formatCurrencyFromCents(milestone.amountCents),
      status: milestone.status,
      ...(milestone.description ? { description: milestone.description } : {}),
      ...(milestone.deadline ? { deadline: milestone.deadline.toISOString() } : {}),
      ...(milestone.requestedTitle ? { requestedTitle: milestone.requestedTitle } : {}),
      ...(milestone.requestedDescription !== null
        ? { requestedDescription: milestone.requestedDescription }
        : {}),
      ...(milestone.requestedAmountCents !== null
        ? { requestedAmount: formatCurrencyFromCents(milestone.requestedAmountCents) }
        : {}),
      ...(milestone.requestedDeadline ? { requestedDeadline: milestone.requestedDeadline.toISOString() } : {}),
      ...(milestone.changeRequestNote ? { changeRequestNote: milestone.changeRequestNote } : {}),
      ...(milestone.changeRequestedAt ? { changeRequestedAt: milestone.changeRequestedAt.toISOString() } : {}),
      ...(milestone.releasedAt ? { releasedAt: milestone.releasedAt.toISOString() } : {}),
      ...(milestone.rejectedAt ? { rejectedAt: milestone.rejectedAt.toISOString() } : {}),
      ...(milestone.reviewDeadline ? { reviewDeadline: milestone.reviewDeadline.toISOString() } : {}),
      ...(milestone.reminderSentAt ? { reminderSentAt: milestone.reminderSentAt.toISOString() } : {}),
      ...(milestone.reviewOverdueAt ? { reviewOverdueAt: milestone.reviewOverdueAt.toISOString() } : {}),
      submissions: milestone.submissions.map((submission) => ({
        id: submission.id,
        submissionNumber: submission.submissionNumber,
        ...(submission.note ? { note: submission.note } : {}),
        submittedAt: submission.submittedAt.toISOString(),
        reviewDeadline: submission.reviewDeadline.toISOString(),
        submitter: { id: submission.submitter.id, name: submission.submitter.name },
        evidence: submission.evidence.map((evidence) => ({
          id: evidence.id,
          objectKey: evidence.objectKey,
          fileName: evidence.fileName,
          contentType: evidence.contentType,
          sizeBytes: evidence.sizeBytes,
          sha256: evidence.sha256,
        })),
        ...(submission.review
          ? {
              review: {
                decision: submission.review.decision,
                ...(submission.review.reason ? { reason: submission.review.reason } : {}),
                reviewedAt: submission.review.reviewedAt.toISOString(),
                reviewer: {
                  id: submission.review.reviewer.id,
                  name: submission.review.reviewer.name,
                },
              },
            }
          : {}),
      })),
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

async function dismissOpenNotificationsForEscrow(
  tx: Prisma.TransactionClient,
  userId: string,
  escrowId: number,
  filters: { label?: string; detailContains?: string } = {},
) {
  await tx.notification.updateMany({
    where: {
      userId,
      txId: escrowId,
      dismissedAt: null,
      ...(filters.label ? { label: filters.label } : {}),
      ...(filters.detailContains ? { detail: { contains: filters.detailContains } } : {}),
    },
    data: {
      dismissedAt: new Date(),
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

function getEscrowStateFromMilestones(
  milestones: ReadonlyArray<{ status: string }>,
  heldCents?: number,
) {
  const remainingPending = milestones.filter((milestone) => ["not_started", "submitted"].includes(milestone.status)).length;
  const rejectedCount = milestones.filter((milestone) => milestone.status === "revision_requested").length;
  const allReleased = milestones.length > 0 && milestones.every((milestone) =>
    ["released", "refunded", "settled", "cancelled"].includes(milestone.status));

  if (allReleased && heldCents === 0) {
    return {
      lifecycleStatus: "completed",
      stage: "Completed",
      dueDescription: "All funds allocated",
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
    prisma.dispute.findMany({
      where: {
        status: { in: ["open", "resolution_proposed", "resolving"] },
        OR: [
          { ownerId: userId },
          { escrow: { OR: [{ buyerId: userId }, { sellerId: userId }] } },
        ],
      },
    }),
    prisma.timelineEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 3,
    }),
  ]);

  const activeEscrows = escrows.filter((escrow) => !["cancelled", "completed", "rejected"].includes(escrow.lifecycleStatus));
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

export async function getEscrowLedgerHistory(
  prisma: PrismaClient,
  userId: string,
  reference: string,
) {
  const escrow = await prisma.escrow.findFirst({
    where: { reference, ...visibleEscrowWhere(userId) },
    select: { id: true, reference: true },
  });
  if (!escrow) throw new AppError("Escrow not found.", 404);
  const entries = await prisma.escrowLedgerEntry.findMany({
    where: { escrowId: escrow.id },
    include: { milestone: { select: { id: true, title: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return {
    escrowId: escrow.reference,
    balances: await getEscrowLedgerBalances(prisma, escrow.id),
    entries: entries.map((entry) => ({
      id: entry.id,
      movementType: entry.movementType,
      amountCents: entry.amountCents,
      currency: entry.currency,
      businessReference: entry.businessReference,
      sourceCommand: entry.sourceCommand,
      actorId: entry.actorId,
      ...(entry.milestone
        ? { milestone: { id: entry.milestone.id, title: entry.milestone.title } }
        : {}),
      ...(entry.paymentProviderRef ? { paymentProviderRef: entry.paymentProviderRef } : {}),
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

export async function createEscrow(
  prisma: PrismaClient,
  userId: string,
  data: CreateEscrowInput,
  idempotencyKey: string,
) {
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
  const counterpartName = counterpartyUser?.name ?? normalizedCounterpartyEmail;
  const creatorPartySnapshot = buildPartySnapshot(owner, data.creatorParty);

  const result = await executeIdempotentCommandWithMetadata(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "create_escrow",
      payload: data,
    },
    async (tx) => {
    await saveBusinessProfile(tx, userId, data.creatorParty);
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
        creatorSignatureDataUrl: data.signatureDataUrl,
        creatorPartySnapshot: creatorPartySnapshot as Prisma.InputJsonObject,
        milestones: {
          create: milestoneInputs.map((milestone, index) => ({
            title: milestone.title.trim(),
            description: milestone.description?.trim() || null,
            amountCents: dollarsToCents(milestone.amount),
            deadline: milestone.deadline ? new Date(milestone.deadline) : null,
            orderIndex: index,
          })),
        },
      };
    const escrow = await tx.escrow.create({
      data: escrowData,
      include: includeEscrowRelations,
    });

    const agreementVersion = await createAgreementVersion(tx, {
      escrowId: escrow.id,
      createdById: userId,
      terms: agreementTermsFromEscrow(escrow),
    });
    await signAgreementVersion(tx, {
      agreementVersionId: agreementVersion.id,
      signerId: userId,
      signerRole: data.creatorRole,
      signatureDataUrl: data.signatureDataUrl,
    });
    await tx.escrow.update({
      where: { id: escrow.id },
      data: { creatorSignatureDataUrl: data.signatureDataUrl },
    });
    await queueEscrowInvitation(tx, {
      escrowId: escrow.id,
      payload: {
        to: normalizedCounterpartyEmail,
        recipientName: counterpartyUser?.name ?? normalizedCounterpartyEmail,
        creatorName: owner.name,
        escrowTitle: escrow.title,
        escrowReference: escrow.reference,
        creatorRole: data.creatorRole,
        invitationStatus,
      },
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

      return {
        success: true,
        escrowId: escrow.id,
        reference: escrow.reference,
        counterpart: escrow.counterpart,
        invitationStatus,
        createdAt: escrow.createdAt.toISOString(),
        invitedEmail: normalizedCounterpartyEmail,
        recipientName: counterpartyUser?.name ?? normalizedCounterpartyEmail,
        creatorName: owner.name,
        escrowTitle: escrow.title,
        creatorRole: data.creatorRole,
      };
    },
  );
  return { ...result.value, replayed: result.replayed };
}

export async function updateDraftEscrow(prisma: PrismaClient, userId: string, reference: string, data: UpdateDraftEscrowInput) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) {
    throw new AppError("Only the escrow creator can edit this draft.", 403);
  }
  if (![
    "pending_counterparty_signup",
    "pending_approval",
    "creator_signature_required",
    "rejected",
  ].includes(escrow.lifecycleStatus)) {
    throw new AppError("This proposal can only be revised before it is funded.", 400);
  }

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
  const buyerId = escrow.creatorRole === "buyer" ? userId : counterpartyReady ? counterpartyUser!.id : null;
  const sellerId = escrow.creatorRole === "seller" ? userId : counterpartyReady ? counterpartyUser!.id : null;
  const counterpartName = counterpartyUser?.name ?? normalizedCounterpartyEmail;

  const result = await prisma.$transaction(async (tx) => {
    await tx.escrowMilestone.deleteMany({ where: { escrowId: escrow.id } });
    const updatedEscrow = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        title: data.title.trim(),
        counterpartyEmail: normalizedCounterpartyEmail,
        counterpart: counterpartName,
        buyerId,
        sellerId,
        amountCents: amountInCents,
        description: data.description?.trim() || null,
        stage: counterpartyReady ? "Creator signature required" : "Invitation pending",
        dueDescription: counterpartyReady
          ? "Sign the corrected agreement before the counterparty can approve it"
          : `Waiting for ${counterpartName} to create and verify an account`,
        status: "warning",
        counterpartyApproved: false,
        lifecycleStatus: counterpartyReady ? "creator_signature_required" : "pending_counterparty_signup",
        rejectedAt: null,
        milestones: {
          create: milestoneInputs.map((milestone, index) => ({
            title: milestone.title.trim(),
            description: milestone.description?.trim() || null,
            amountCents: dollarsToCents(milestone.amount),
            deadline: milestone.deadline ? new Date(milestone.deadline) : null,
            orderIndex: index,
          })),
        },
      },
      include: includeEscrowRelations,
    });
    await createAgreementVersion(tx, {
      escrowId: updatedEscrow.id,
      createdById: userId,
      terms: agreementTermsFromEscrow(updatedEscrow),
    });
    await queueEscrowInvitation(tx, {
      escrowId: updatedEscrow.id,
      supersedeExisting: true,
      payload: {
        to: normalizedCounterpartyEmail,
        recipientName: counterpartyUser?.name ?? normalizedCounterpartyEmail,
        creatorName: owner.name,
        escrowTitle: updatedEscrow.title,
        escrowReference: updatedEscrow.reference,
        creatorRole: updatedEscrow.creatorRole as "buyer" | "seller",
        invitationStatus,
      },
    });

    await createTimeline(
      tx,
      userId,
      `${updatedEscrow.reference} draft updated`,
      `${updatedEscrow.title} is waiting on ${counterpartName}`,
      "attention",
    );
    await createNotification(
      tx,
      userId,
      "Escrow draft updated",
      counterpartyReady
        ? `${counterpartName} can now review ${updatedEscrow.title}.`
        : `${counterpartName} must finish signup before the escrow can be reviewed.`,
      "Just now",
      updatedEscrow.id,
    );

    if (counterpartyUser && counterpartyReady) {
      await createTimeline(
        tx,
        counterpartyUser.id,
        `${owner.name} invited you to escrow`,
        `${updatedEscrow.title} is awaiting your approval`,
        "attention",
      );
      await createNotification(
        tx,
        counterpartyUser.id,
        "Escrow approval requested",
        `${owner.name} invited you to review ${updatedEscrow.title}.`,
        "Just now",
        updatedEscrow.id,
      );
    }

    return { escrow: updatedEscrow, owner, counterpartyUser, invitationStatus, invitedEmail: normalizedCounterpartyEmail };
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
      const creatorSigned = escrow.currentAgreementVersion?.signatures.some(
        (signature) => signature.signerId === escrow.ownerId,
      ) ?? false;
      const updated = await tx.escrow.update({
        where: { id: escrow.id },
        data: {
          buyerId: isSellerInvite ? escrow.buyerId : user.id,
          sellerId: isSellerInvite ? user.id : escrow.sellerId,
          counterpart: user.name,
          lifecycleStatus: creatorSigned ? "pending_approval" : "creator_signature_required",
          stage: creatorSigned ? "Approval pending" : "Creator signature required",
          dueDescription: creatorSigned
            ? `Waiting for ${user.name} to approve`
            : "Creator must sign the current agreement before approval",
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
  data: ApproveEscrowInput,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId === userId) {
    throw new AppError("Only the invited counterparty can approve this escrow.", 403);
  }
  if (escrow.lifecycleStatus !== "pending_approval") {
    throw new AppError("This escrow is not awaiting approval.", 400);
  }
  if (hasPendingAgreementChanges(escrow)) {
    throw new AppError("Requested agreement changes must be reviewed before approval.", 400);
  }
  const user = escrow.buyerId === userId ? escrow.buyer : escrow.seller;
  if (!user) {
    throw new AppError("Counterparty account is not attached to this escrow.", 400);
  }
  const counterpartyPartySnapshot = buildPartySnapshot(user, data.counterpartyParty);
  if (!escrow.currentAgreementVersionId) {
    throw new AppError("This escrow does not have a current agreement version.", 409);
  }

  return prisma.$transaction(async (tx) => {
    await saveBusinessProfile(tx, userId, data.counterpartyParty);
    await tx.agreementVersion.update({
      where: { id: escrow.currentAgreementVersionId! },
      data: { counterpartyParty: counterpartyPartySnapshot as Prisma.InputJsonObject },
    });
    await signAgreementVersion(tx, {
      agreementVersionId: escrow.currentAgreementVersionId!,
      signerId: userId,
      signerRole: escrow.buyerId === userId ? "buyer" : "seller",
      signatureDataUrl: data.signatureDataUrl,
    });
    await lockAgreementIfFullySigned(tx, {
      agreementVersionId: escrow.currentAgreementVersionId!,
      buyerId: requireBuyerId(escrow),
      sellerId: requireSellerId(escrow),
    });
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        counterpartyApproved: true,
        lifecycleStatus: "funding_pending",
        stage: "Funding pending",
        dueDescription: "Buyer funding required",
        status: "warning",
        approvedAt: new Date(),
        counterpartySignatureDataUrl: data.signatureDataUrl,
        counterpartyPartySnapshot: counterpartyPartySnapshot as Prisma.InputJsonObject,
      },
      include: includeEscrowRelations,
    });
    await markInvitationAccepted(tx, escrow.id);

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
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id);

    return updated;
  });
}

export async function signCurrentAgreement(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  signatureDataUrl: string,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (!escrow.currentAgreementVersionId) {
    throw new AppError("This escrow does not have a current agreement version.", 409);
  }
  if (!["pending_counterparty_signup", "pending_approval", "creator_signature_required", "changes_requested"].includes(escrow.lifecycleStatus)) {
    throw new AppError("This agreement can no longer be signed.", 409);
  }
  const signerRole = escrow.buyerId === userId ? "buyer" : "seller";
  return prisma.$transaction(async (tx) => {
    const signature = await signAgreementVersion(tx, {
      agreementVersionId: escrow.currentAgreementVersionId!,
      signerId: userId,
      signerRole,
      signatureDataUrl,
    });
    const isCreator = escrow.ownerId === userId;
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        ...(isCreator
          ? { creatorSignatureDataUrl: signatureDataUrl }
          : { counterpartySignatureDataUrl: signatureDataUrl }),
        ...(isCreator && escrow.lifecycleStatus === "creator_signature_required"
          ? {
              lifecycleStatus: "pending_approval",
              stage: "Approval pending",
              dueDescription: `Waiting for ${escrow.counterpart} to approve`,
            }
          : {}),
      },
      include: includeEscrowRelations,
    });
    return { escrow: updated, signature };
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
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id);

    return updated;
  });
}

export async function resendEscrowInvitation(
  prisma: PrismaClient,
  userId: string,
  reference: string,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) {
    throw new AppError("Only the creator can resend this invitation.", 403);
  }
  if (!["pending_counterparty_signup", "pending_approval", "creator_signature_required", "rejected"].includes(escrow.lifecycleStatus)) {
    throw new AppError("This invitation cannot be resent in its current state.", 409);
  }
  const counterpartyUser = await prisma.user.findUnique({
    where: { email: escrow.counterpartyEmail },
  });
  const invitationStatus: EscrowInvitationStatus = !counterpartyUser
    ? "signup_required"
    : counterpartyUser.emailVerified
      ? "existing_user"
      : "verification_required";
  return prisma.$transaction(async (tx) => {
    const delivery = await queueEscrowInvitation(tx, {
      escrowId: escrow.id,
      supersedeExisting: true,
      payload: {
        to: escrow.counterpartyEmail,
        recipientName: counterpartyUser?.name ?? escrow.counterpart,
        creatorName: escrow.owner.name,
        escrowTitle: escrow.title,
        escrowReference: escrow.reference,
        creatorRole: escrow.creatorRole as "buyer" | "seller",
        invitationStatus,
      },
    });
    const creatorSigned = escrow.currentAgreementVersion?.signatures.some(
      (signature) => signature.signerId === escrow.ownerId,
    ) ?? false;
    const readyLifecycle = creatorSigned ? "pending_approval" : "creator_signature_required";
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: invitationStatus === "existing_user" ? readyLifecycle : "pending_counterparty_signup",
        stage: invitationStatus === "existing_user"
          ? creatorSigned ? "Approval pending" : "Creator signature required"
          : "Invitation pending",
        dueDescription: invitationStatus === "existing_user"
          ? creatorSigned
            ? `Waiting for ${counterpartyUser?.name ?? escrow.counterpart} to approve`
            : "Sign the current agreement before the counterparty can approve it"
          : `Waiting for ${escrow.counterpartyEmail} to create and verify an account`,
        rejectedAt: null,
      },
      include: includeEscrowRelations,
    });
    return { escrow: updated, delivery };
  });
}

export async function extendEscrowInvitation(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  days: number,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) throw new AppError("Only the creator can extend this invitation.", 403);
  if (escrow.fundingStatus === "funded") throw new AppError("A funded escrow has no open invitation.", 409);
  const delivery = escrow.invitationDeliveries[0];
  if (!delivery || delivery.status === "accepted" || delivery.status === "corrected") {
    throw new AppError("No open invitation is available to extend.", 409);
  }
  const base = delivery.expiresAt.getTime() > Date.now() ? delivery.expiresAt : new Date();
  const expiresAt = new Date(base.getTime() + days * 86_400_000);
  const responseDueAt = new Date(expiresAt.getTime());
  return prisma.$transaction(async (tx) => {
    await tx.escrow.update({
      where: { id: escrow.id },
      data: { invitationExpiresAt: expiresAt, agreementResponseDueAt: responseDueAt },
    });
    return tx.invitationDelivery.update({
      where: { id: delivery.id },
      data: { expiresAt, responseDueAt, status: delivery.status === "failed" ? "failed" : "delivered" },
    });
  });
}

export async function requestMilestoneChanges(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  data: MilestoneChangeRequestInput,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId === userId) {
    throw new AppError("Only the invited counterparty can request changes.", 403);
  }
  if (!["pending_approval", "changes_requested"].includes(escrow.lifecycleStatus)) {
    throw new AppError("Changes can only be requested before escrow approval.", 400);
  }
  const milestone = getMilestoneById(escrow, milestoneId);
  if (milestone.status !== "not_started") {
    throw new AppError("Only pending milestones can be revised.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const requestedAt = new Date();
    await tx.escrowMilestone.update({
      where: { id: milestoneId },
      data: {
        requestedTitle: data.title.trim(),
        requestedDescription: data.description?.trim() ?? "",
        requestedAmountCents: dollarsToCents(data.amount),
        requestedDeadline: data.deadline ? new Date(data.deadline) : null,
        changeRequestNote: data.note?.trim() || null,
        changeRequestedAt: requestedAt,
      },
    });
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: "changes_requested",
        stage: "Changes requested",
        dueDescription: "Milestone revisions requested",
        counterpartyApproved: false,
      },
      include: includeEscrowRelations,
    });
    await createTimeline(
      tx,
      escrow.ownerId,
      `Changes requested for ${milestone.title}`,
      `${updated.counterpart} proposed milestone revisions`,
      "attention",
    );
    await createNotification(
      tx,
      escrow.ownerId,
      "Milestone changes requested",
      `${updated.counterpart} requested changes to ${milestone.title}.`,
      "Just now",
      updated.id,
    );
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id);
    return updated;
  });
}

function assertAgreementMilestoneTotal(amountCents: number, milestones: AgreementMilestoneChangeInput[]) {
  const proposedTotalCents = milestones.reduce((total, milestone) => total + dollarsToCents(milestone.amount), 0);
  if (proposedTotalCents !== amountCents) {
    throw new AppError("Milestone amounts must add up to the escrow amount.", 400);
  }
}

export async function requestAgreementChanges(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  data: AgreementChangeRequestInput,
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId === userId) {
    throw new AppError("Only the invited counterparty can request changes.", 403);
  }
  if (!["pending_approval", "changes_requested"].includes(escrow.lifecycleStatus)) {
    throw new AppError("Changes can only be requested before escrow approval.", 400);
  }

  assertAgreementMilestoneTotal(escrow.amountCents, data.milestones);

  const existingPendingIds = new Set(
    escrow.milestones
      .filter((milestone) => milestone.status === "not_started" && !isProposedNewMilestone(milestone))
      .map((milestone) => milestone.id),
  );
  const proposedExistingIds = new Set(
    data.milestones
      .map((milestone) => milestone.milestoneId)
      .filter((milestoneId): milestoneId is number => milestoneId !== undefined),
  );
  const missingExisting = [...existingPendingIds].filter((milestoneId) => !proposedExistingIds.has(milestoneId));
  if (missingExisting.length) {
    throw new AppError("Review the whole agreement before requesting changes.", 400);
  }

  return prisma.$transaction(async (tx) => {
    const requestedAt = new Date();
    const note = data.note?.trim() || null;
    await tx.escrowMilestone.deleteMany({
      where: {
        escrowId: escrow.id,
        title: PROPOSED_NEW_MILESTONE_TITLE,
        amountCents: 0,
        changeRequestedAt: { not: null },
      },
    });

    for (const milestone of data.milestones) {
      const requestedData = {
        requestedTitle: milestone.title.trim(),
        requestedDescription: milestone.description?.trim() ?? "",
        requestedAmountCents: dollarsToCents(milestone.amount),
        requestedDeadline: milestone.deadline ? new Date(milestone.deadline) : null,
        changeRequestNote: note,
        changeRequestedAt: requestedAt,
      };
      if (milestone.milestoneId) {
        if (!existingPendingIds.has(milestone.milestoneId)) {
          throw new AppError("Only pending milestones can be revised.", 400);
        }
        await tx.escrowMilestone.update({
          where: { id: milestone.milestoneId },
          data: requestedData,
        });
      } else {
        const nextOrderIndex = escrow.milestones.length + data.milestones.indexOf(milestone);
        await tx.escrowMilestone.create({
          data: {
            escrowId: escrow.id,
            title: PROPOSED_NEW_MILESTONE_TITLE,
            description: null,
            amountCents: 0,
            deadline: null,
            orderIndex: nextOrderIndex,
            status: "not_started",
            ...requestedData,
          },
        });
      }
    }

    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: "changes_requested",
        stage: "Changes requested",
        dueDescription: "Agreement revisions requested",
        counterpartyApproved: false,
      },
      include: includeEscrowRelations,
    });

    await createTimeline(
      tx,
      escrow.ownerId,
      `Changes requested for ${updated.reference}`,
      `${updated.counterpart} proposed agreement revisions`,
      "attention",
    );
    await createNotification(
      tx,
      escrow.ownerId,
      "Agreement changes requested",
      `${updated.counterpart} requested changes to the agreement.`,
      "Just now",
      updated.id,
    );
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id);
    return updated;
  });
}

export async function applyAgreementChanges(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  data: AgreementChangeReviewInput = { decision: "accept" },
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) {
    throw new AppError("Only the escrow creator can apply requested changes.", 403);
  }
  if (escrow.lifecycleStatus !== "changes_requested") {
    throw new AppError("This escrow has no requested changes.", 400);
  }
  const requestedMilestones = escrow.milestones.filter((milestone) => milestone.changeRequestedAt !== null);
  if (requestedMilestones.length === 0) {
    throw new AppError("This escrow has no requested changes.", 400);
  }
  const acceptsChanges = data.decision === "accept";
  const reviewMilestones = data.milestones ?? requestedMilestones.map((milestone) => ({
    milestoneId: milestone.id,
    title: milestone.requestedTitle ?? milestone.title,
    description: milestone.requestedDescription ?? milestone.description ?? undefined,
    amount: (milestone.requestedAmountCents ?? milestone.amountCents) / 100,
    ...(milestone.requestedDeadline ? { deadline: milestone.requestedDeadline.toISOString() } : {}),
  }));

  if (acceptsChanges) {
    assertAgreementMilestoneTotal(escrow.amountCents, reviewMilestones);
  }

  return prisma.$transaction(async (tx) => {
    if (!acceptsChanges) {
      await tx.escrowMilestone.deleteMany({
        where: {
          escrowId: escrow.id,
          title: PROPOSED_NEW_MILESTONE_TITLE,
          amountCents: 0,
          changeRequestedAt: { not: null },
        },
      });
      await tx.escrowMilestone.updateMany({
        where: { escrowId: escrow.id, changeRequestedAt: { not: null } },
        data: {
          requestedTitle: null,
          requestedDescription: null,
          requestedAmountCents: null,
          requestedDeadline: null,
          changeRequestNote: null,
          changeRequestedAt: null,
        },
      });
    } else {
      for (const milestone of reviewMilestones) {
        if (!milestone.milestoneId) continue;
        const original = requestedMilestones.find((item) => item.id === milestone.milestoneId);
        if (!original) {
          throw new AppError("Requested milestone not found.", 400);
        }
        await tx.escrowMilestone.update({
          where: { id: milestone.milestoneId },
          data: {
            title: milestone.title.trim(),
            description: milestone.description?.trim() || null,
            amountCents: dollarsToCents(milestone.amount),
            deadline: milestone.deadline ? new Date(milestone.deadline) : null,
            requestedTitle: null,
            requestedDescription: null,
            requestedAmountCents: null,
            requestedDeadline: null,
            changeRequestNote: null,
            changeRequestedAt: null,
          },
        });
      }
    }

    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        lifecycleStatus: acceptsChanges ? "creator_signature_required" : "pending_approval",
        stage: acceptsChanges ? "Creator signature required" : "Approval pending",
        dueDescription: acceptsChanges
          ? "Sign the updated agreement before resending"
          : `Waiting for ${escrow.counterpart} to approve`,
      },
      include: includeEscrowRelations,
    });
    if (acceptsChanges) {
      await createAgreementVersion(tx, {
        escrowId: updated.id,
        createdById: userId,
        terms: agreementTermsFromEscrow(updated),
      });
    }
    const counterpartyId = escrow.ownerId === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
    if (counterpartyId) {
      await createTimeline(
        tx,
        counterpartyId,
        `${updated.reference} agreement review completed`,
        acceptsChanges ? "The creator accepted the requested agreement changes" : "The creator kept the original agreement",
        "attention",
      );
      await createNotification(
        tx,
        counterpartyId,
        acceptsChanges ? "Requested agreement updated" : "Original agreement retained",
        acceptsChanges ? `${updated.owner.name} accepted your requested agreement changes.` : `${updated.owner.name} kept the original agreement terms.`,
        "Just now",
        updated.id,
      );
    }
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id, { label: "Agreement changes requested" });
    return updated;
  });
}

export async function applyMilestoneChanges(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  data: MilestoneChangeReviewInput = { decision: "accept" },
) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) {
    throw new AppError("Only the escrow creator can apply requested changes.", 403);
  }
  if (escrow.lifecycleStatus !== "changes_requested") {
    throw new AppError("This escrow has no requested changes.", 400);
  }
  const milestone = getMilestoneById(escrow, milestoneId);
  if (!milestone.changeRequestedAt || !milestone.requestedTitle || milestone.requestedAmountCents === null) {
    throw new AppError("This milestone has no requested changes.", 400);
  }
  const acceptsChanges = data.decision === "accept";
  const acceptedTitle = data.title?.trim() || milestone.requestedTitle;
  const acceptedDescription =
    data.description === undefined ? milestone.requestedDescription?.trim() || null : data.description.trim() || null;
  const acceptedAmountCents = data.amount === undefined ? milestone.requestedAmountCents : dollarsToCents(data.amount);
  const acceptedDeadline =
    data.deadline === undefined
      ? milestone.requestedDeadline
      : data.deadline === null
        ? null
        : new Date(data.deadline);

  return prisma.$transaction(async (tx) => {
    await tx.escrowMilestone.update({
      where: { id: milestoneId },
      data: {
        ...(acceptsChanges
          ? {
              title: acceptedTitle,
              description: acceptedDescription,
              amountCents: acceptedAmountCents,
              deadline: acceptedDeadline,
            }
          : {}),
        requestedTitle: null,
        requestedDescription: null,
        requestedAmountCents: null,
        requestedDeadline: null,
        changeRequestNote: null,
        changeRequestedAt: null,
      },
    });
    const milestones = await tx.escrowMilestone.findMany({
      where: { escrowId: escrow.id },
      orderBy: { orderIndex: "asc" },
    });
    const remainingRequests = milestones.filter((item) => item.changeRequestedAt !== null).length;
    const amountCents = milestones.reduce((total, item) => total + item.amountCents, 0);
    const updated = await tx.escrow.update({
      where: { id: escrow.id },
      data: {
        amountCents,
        lifecycleStatus: remainingRequests
          ? "changes_requested"
          : acceptsChanges
            ? "creator_signature_required"
            : "pending_approval",
        stage: remainingRequests
          ? "Changes requested"
          : acceptsChanges
            ? "Creator signature required"
            : "Approval pending",
        dueDescription: remainingRequests
          ? `${remainingRequests} milestone revision(s) pending`
          : acceptsChanges
            ? "Sign the updated agreement before resending"
            : `Waiting for ${escrow.counterpart} to approve`,
      },
      include: includeEscrowRelations,
    });
    if (!remainingRequests && acceptsChanges) {
      await createAgreementVersion(tx, {
        escrowId: updated.id,
        createdById: userId,
        terms: agreementTermsFromEscrow(updated),
      });
    }
    const counterpartyId = escrow.ownerId === escrow.buyerId ? escrow.sellerId : escrow.buyerId;
    if (counterpartyId) {
      await createTimeline(
        tx,
        counterpartyId,
        `${updated.reference} milestone review completed`,
        acceptsChanges
          ? `${milestone.title} was updated by the creator`
          : `${updated.owner.name} kept the original ${milestone.title} terms`,
        "attention",
      );
      await createNotification(
        tx,
        counterpartyId,
        acceptsChanges ? "Requested milestone updated" : "Original milestone retained",
        acceptsChanges
          ? `${updated.owner.name} accepted your requested changes to ${milestone.title}.`
          : `${updated.owner.name} kept the original terms for ${milestone.title}.`,
        "Just now",
        updated.id,
      );
    }
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id, {
      label: "Milestone changes requested",
      detailContains: milestone.title,
    });
    return updated;
  });
}

export async function cancelEscrow(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  if (escrow.ownerId !== userId) {
    throw new AppError("Only the creator can cancel this escrow.", 403);
  }
  const cancellableStates = [
    "pending_counterparty_signup",
    "pending_approval",
    "changes_requested",
    "creator_signature_required",
    "rejected",
  ];
  if (escrow.fundingStatus === "funded" || ["funded", "completed"].includes(escrow.lifecycleStatus)) {
    throw new AppError(
      "Funded escrows cannot be cancelled until the refund workflow is available.",
      409,
    );
  }
  if (!cancellableStates.includes(escrow.lifecycleStatus)) {
    throw new AppError("This escrow can no longer be cancelled.", 409);
  }

  return prisma.$transaction(async (tx) => {
    const transition = await tx.escrow.updateMany({
      where: {
        id: escrow.id,
        ownerId: userId,
        lifecycleStatus: { in: cancellableStates },
        fundingStatus: "not_funded",
      },
      data: {
        lifecycleStatus: "cancelled",
        stage: "Cancelled",
        dueDescription: "Escrow cancelled",
        status: "warning",
        cancelledAt: new Date(),
      },
    });
    if (transition.count !== 1) {
      throw new AppError("The escrow changed before it could be cancelled. Refresh and try again.", 409);
    }

    const updated = await tx.escrow.findUnique({
      where: { id: escrow.id },
      include: includeEscrowRelations,
    });
    if (!updated) {
      throw new AppError("Escrow not found.", 404);
    }

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
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id);

    return updated;
  });
}

export async function fundEscrow(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  idempotencyKey: string,
) {
  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "fund_escrow",
      payload: { reference },
    },
    async (tx) => {
      const escrow = await tx.escrow.findFirst({
        where: { reference, ...visibleEscrowWhere(userId) },
        include: includeEscrowRelations,
      });
      if (!escrow) throw new AppError("Escrow not found.", 404);
      const buyerId = requireBuyerId(escrow);
      if (buyerId !== userId) {
        throw new AppError("Only the buyer can fund this escrow.", 403);
      }
      if (escrow.lifecycleStatus !== "funding_pending") {
        if (escrow.fundingStatus === "funded") {
          throw new AppError("This escrow has already been funded.", 409);
        }
        throw new AppError("This escrow is not ready for funding.", 400);
      }
      if (hasPendingAgreementChanges(escrow)) {
        throw new AppError("Requested agreement changes must be resolved before funding.", 400);
      }
      await assertFundableAgreement(tx, {
        currentAgreementVersionId: escrow.currentAgreementVersionId,
        buyerId,
        sellerId: requireSellerId(escrow),
      });

      const fundedAt = new Date();
    const transition = await tx.escrow.updateMany({
      where: {
        id: escrow.id,
        lifecycleStatus: "funding_pending",
        fundingStatus: "not_funded",
      },
      data: {
        lifecycleStatus: "funded",
        fundingStatus: "funded",
        stage: "Milestones active",
        dueDescription: "Funds secured in escrow",
        status: "success",
        fundedAt,
      },
    });
    if (transition.count !== 1) {
      throw new AppError("This escrow was already funded or its state changed. Refresh and try again.", 409);
    }

      await applyEscrowTransfer(tx, {
        escrowId: escrow.id,
        movementType: "fund",
        amountCents: escrow.amountCents,
        idempotencyKey,
        businessReference: `escrow:${escrow.reference}:fund`,
        actorId: userId,
        sourceCommand: "fund_escrow",
        walletUserId: userId,
      });

      const updated = await tx.escrow.findUnique({
        where: { id: escrow.id },
        include: includeEscrowRelations,
      });
      if (!updated) {
        throw new AppError("Escrow not found.", 404);
      }

      const sellerId = requireSellerId(updated);
      await createTimeline(tx, userId, `${updated.reference} funded`, "Funds secured in escrow", "funding");
      await createTimeline(tx, sellerId, `${updated.reference} funded`, "Work can begin", "funding");
      await createNotification(
        tx,
        sellerId,
        "Escrow funded",
        `${updated.title} is funded and ready for milestone work.`,
        "Just now",
        updated.id,
      );
      await dismissOpenNotificationsForEscrow(tx, userId, escrow.id);

      return {
        success: true,
        escrowId: updated.reference,
        fundedAt: fundedAt.toISOString(),
      };
    });
}

export async function releaseEscrow(prisma: PrismaClient, userId: string, reference: string) {
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const buyerId = requireBuyerId(escrow);
  if (buyerId !== userId) {
    throw new AppError("Only the buyer can release this escrow.", 403);
  }
  throw new AppError(
    "Full escrow release is disabled. Approve each milestone separately.",
    409,
  );
}

export async function approveMilestone(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  idempotencyKey: string,
  reason?: string,
) {
  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "approve_milestone",
      payload: { reference, milestoneId, reason: reason?.trim() || null },
    },
    async (tx) => {
      const escrow = await tx.escrow.findFirst({
        where: { reference, ...visibleEscrowWhere(userId) },
        include: includeEscrowRelations,
      });
      if (!escrow) throw new AppError("Escrow not found.", 404);
      const buyerId = requireBuyerId(escrow);
      if (buyerId !== userId) {
        throw new AppError("Only the buyer can approve milestone releases.", 403);
      }
      if (escrow.lifecycleStatus !== "funded") {
        if (escrow.lifecycleStatus === "completed") {
          throw new AppError("This milestone was already processed. Refresh to see its current state.", 409);
        }
        throw new AppError("Milestones can only be approved after funding.", 400);
      }

      const targetMilestone = getMilestoneById(escrow, milestoneId);
      if (targetMilestone.status !== "submitted") {
        throw new AppError("The seller must submit this milestone before it can be approved.", 409);
      }
      const submission = targetMilestone.submissions.at(-1);
      if (!submission || submission.review) {
        throw new AppError("This milestone does not have an open submission to review.", 409);
      }

      const escrowLock = await tx.escrow.updateMany({
        where: { id: escrow.id, lifecycleStatus: "funded" },
        data: { updatedAt: new Date() },
      });
      if (escrowLock.count !== 1) {
        throw new AppError("The escrow changed before this milestone could be released. Refresh and try again.", 409);
      }

      const releasedAt = new Date();
      const milestoneTransition = await tx.escrowMilestone.updateMany({
        where: {
          id: milestoneId,
          escrowId: escrow.id,
          status: "submitted",
        },
        data: {
          status: "released",
          releasedAt,
          rejectedAt: null,
          reviewDeadline: null,
          reminderAt: null,
        },
      });
      if (milestoneTransition.count !== 1) {
        throw new AppError("This milestone was already processed. Refresh to see its current state.", 409);
      }

      await tx.milestoneReview.create({
        data: {
          submissionId: submission.id,
          reviewerId: userId,
          decision: "approved",
          reason: reason?.trim() || null,
        },
      });

      const transfer = await applyEscrowTransfer(tx, {
        escrowId: escrow.id,
        milestoneId,
        movementType: "release",
        amountCents: targetMilestone.amountCents,
        idempotencyKey,
        businessReference: `escrow:${escrow.reference}:milestone:${milestoneId}:release`,
        actorId: userId,
        sourceCommand: "approve_milestone",
        walletUserId: requireSellerId(escrow),
      });

      const milestones = await tx.escrowMilestone.findMany({
        where: { escrowId: escrow.id },
        orderBy: { orderIndex: "asc" },
      });
      const state = getEscrowStateFromMilestones(milestones, transfer.balances.heldCents);
      const updatedEscrow = await tx.escrow.update({
        where: { id: escrow.id },
        data: state,
        include: includeEscrowRelations,
      });

      await createTimeline(
        tx,
        requireSellerId(updatedEscrow),
        `Milestone released for ${updatedEscrow.reference}`,
        `${targetMilestone.title} paid out`,
        "released",
      );
      await createTimeline(
        tx,
        requireBuyerId(updatedEscrow),
        `You released ${targetMilestone.title}`,
        `${formatCurrencyFromCents(targetMilestone.amountCents)} sent to ${updatedEscrow.seller?.name ?? updatedEscrow.counterpart}`,
        "released",
      );
      await createNotification(
        tx,
        requireSellerId(updatedEscrow),
        "Milestone released",
        `${targetMilestone.title} funds were released to your wallet.`,
        "Just now",
        updatedEscrow.id,
      );
      await dismissOpenNotificationsForEscrow(tx, userId, escrow.id, {
        label: "Milestone resubmitted",
        detailContains: targetMilestone.title,
      });

      return {
        success: true,
        escrowId: updatedEscrow.reference,
        milestoneId,
        releasedAt: releasedAt.toISOString(),
      };
    });
}

export async function rejectMilestone(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  reason: string,
): Promise<MilestoneActionResult> {
  const revisionReason = reason.trim();
  if (revisionReason.length < 3) {
    throw new AppError("Explain what the seller needs to revise.", 400);
  }
  const escrow = await findEscrowForUser(prisma, userId, reference);
  const buyerId = requireBuyerId(escrow);
  if (buyerId !== userId) {
    throw new AppError("Only the buyer can reject milestones.", 403);
  }
  if (escrow.lifecycleStatus !== "funded") {
    if (escrow.lifecycleStatus === "completed") {
      throw new AppError("This milestone was already processed. Refresh to see its current state.", 409);
    }
    throw new AppError("Milestones can only be reviewed after funding.", 400);
  }

  const targetMilestone = getMilestoneById(escrow, milestoneId);
  if (targetMilestone.status !== "submitted") {
    throw new AppError("The seller must submit this milestone before a revision can be requested.", 409);
  }
  const submission = targetMilestone.submissions.at(-1);
  if (!submission || submission.review) {
    throw new AppError("This milestone does not have an open submission to review.", 409);
  }

  return prisma.$transaction(async (tx) => {
    const escrowLock = await tx.escrow.updateMany({
      where: { id: escrow.id, lifecycleStatus: "funded" },
      data: { updatedAt: new Date() },
    });
    if (escrowLock.count !== 1) {
      throw new AppError("The escrow changed before this milestone could be rejected. Refresh and try again.", 409);
    }

    const rejectedAt = new Date();
    const milestoneTransition = await tx.escrowMilestone.updateMany({
      where: {
        id: milestoneId,
        escrowId: escrow.id,
        status: "submitted",
      },
      data: {
        status: "revision_requested",
        rejectedAt,
        reviewDeadline: null,
        reminderAt: null,
      },
    });
    if (milestoneTransition.count !== 1) {
      throw new AppError("This milestone was already processed. Refresh to see its current state.", 409);
    }

    await tx.milestoneReview.create({
      data: {
        submissionId: submission.id,
        reviewerId: userId,
        decision: "revision_requested",
        reason: revisionReason,
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
      `${targetMilestone.title} needs revision: ${revisionReason}`,
      "attention",
    );
    await createTimeline(
      tx,
      requireBuyerId(updatedEscrow),
      `You rejected ${targetMilestone.title}`,
      revisionReason,
      "attention",
    );
    await createNotification(
      tx,
      requireSellerId(updatedEscrow),
      "Milestone needs revision",
      `${targetMilestone.title} needs revision: ${revisionReason}`,
      "Just now",
      updatedEscrow.id,
    );
    await dismissOpenNotificationsForEscrow(tx, userId, escrow.id, {
      label: "Milestone resubmitted",
      detailContains: targetMilestone.title,
    });

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
  data: MilestoneSubmissionInput,
  idempotencyKey: string,
) {
  return submitMilestoneWork(prisma, userId, reference, milestoneId, data, idempotencyKey);
}

export async function listDisputes(prisma: PrismaClient, userId: string): Promise<DisputeResponse[]> {
  const disputes = await prisma.dispute.findMany({
    where: {
      status: { in: ["open", "resolution_proposed", "resolving"] },
      OR: [
        { ownerId: userId },
        { escrow: { OR: [{ buyerId: userId }, { sellerId: userId }] } },
      ],
    },
    include: {
      escrow: { select: { reference: true } },
      openedBy: { select: { id: true, name: true } },
      evidenceSubmissions: {
        include: { submitter: { select: { id: true, name: true } } },
        orderBy: { submittedAt: "asc" },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  return disputes.map((dispute) => ({
    id: dispute.reference,
    title: dispute.title,
    owner: dispute.ownerTeam,
    amount: formatAmountWithSuffix(dispute.amountFrozenCents || dispute.amountCents),
    updated: dispute.updatedLabel,
    priority: dispute.priority,
    status: dispute.status,
    ...(dispute.reason ? { reason: dispute.reason } : {}),
    ...(dispute.escrow ? { escrowId: dispute.escrow.reference } : {}),
    ...(dispute.milestoneId ? { milestoneId: dispute.milestoneId } : {}),
    amountFrozenCents: dispute.amountFrozenCents,
    ...(dispute.evidenceWindowEndsAt
      ? { evidenceWindowEndsAt: dispute.evidenceWindowEndsAt.toISOString() }
      : {}),
    ...(dispute.openedBy
      ? { openedBy: { id: dispute.openedBy.id, name: dispute.openedBy.name } }
      : {}),
    ...(dispute.resolutionProposedById
      && dispute.proposedSellerCents !== null
      && dispute.proposedBuyerCents !== null
      ? {
          resolution: {
            proposedById: dispute.resolutionProposedById,
            sellerCents: dispute.proposedSellerCents,
            buyerCents: dispute.proposedBuyerCents,
            ...(dispute.resolutionNote ? { note: dispute.resolutionNote } : {}),
          },
        }
      : {}),
    evidence: dispute.evidenceSubmissions.map((submission) => ({
      id: submission.id,
      ...(submission.note ? { note: submission.note } : {}),
      submittedAt: submission.submittedAt.toISOString(),
      submitter: submission.submitter,
      references: Array.isArray(submission.evidence)
        ? submission.evidence as DisputeResponse["evidence"][number]["references"]
        : [],
    })),
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

export async function listNotifications(prisma: PrismaClient, userId: string, includeDismissed = false) {
  const notifications = await prisma.notification.findMany({
    where: { userId, ...(includeDismissed ? {} : { dismissedAt: null }) },
    orderBy: { createdAt: "desc" },
  });
  const activeNotifications = includeDismissed
    ? notifications
    : await filterResolvedMilestoneNotifications(prisma, notifications);
  return activeNotifications.map((notification) => ({
    id: notification.id,
    label: notification.label,
    detail: notification.detail,
    meta: notification.meta,
    txId: notification.txId ?? undefined,
    createdAt: notification.createdAt.toISOString(),
  }));
}

type NotificationLike = {
  id: string;
  label: string;
  detail: string;
  meta: string;
  txId: number | null;
  createdAt: Date;
  dismissedAt: Date | null;
};

const milestoneTitleFromNotification = (label: string, detail: string) => {
  if (label === "Milestone changes requested") {
    return detail.match(/requested changes to (.+?)\.$/)?.[1]?.trim() ?? null;
  }
  if (label === "Milestone resubmitted") {
    return detail.match(/^(.+?) was resubmitted\b/)?.[1]?.trim() ?? null;
  }
  if (label === "Milestone needs revision") {
    return detail.match(/^(.+?) was rejected\b/)?.[1]?.trim() ?? null;
  }
  return null;
};

const isMilestoneNotificationStillActionable = (
  notification: NotificationLike,
  milestones: Array<{ title: string; status: string; changeRequestedAt: Date | null }>,
) => {
  const title = milestoneTitleFromNotification(notification.label, notification.detail);
  if (notification.label === "Agreement changes requested") {
    return milestones.some((milestone) => milestone.changeRequestedAt !== null);
  }
  if (!title) return true;
  const matchingMilestones = milestones.filter((milestone) => milestone.title === title);
  if (notification.label === "Milestone changes requested") {
    return matchingMilestones.some((milestone) => milestone.changeRequestedAt !== null);
  }
  if (notification.label === "Milestone resubmitted") {
    return matchingMilestones.some((milestone) => milestone.status === "submitted");
  }
  if (notification.label === "Milestone needs revision") {
    return matchingMilestones.some((milestone) => milestone.status === "revision_requested");
  }
  return true;
};

async function filterResolvedMilestoneNotifications(
  prisma: PrismaClient,
  notifications: NotificationLike[],
) {
  const milestoneNotifications = notifications.filter((notification) =>
    ["Agreement changes requested", "Milestone changes requested", "Milestone resubmitted", "Milestone needs revision"].includes(notification.label)
    && notification.txId !== null
  );
  if (milestoneNotifications.length === 0) {
    return notifications;
  }
  const escrowIds = [...new Set(milestoneNotifications.map((notification) => notification.txId!))];
  const escrows = await prisma.escrow.findMany({
    where: { id: { in: escrowIds } },
    select: {
      id: true,
      milestones: {
        select: {
          title: true,
          status: true,
          changeRequestedAt: true,
        },
      },
    },
  });
  const milestonesByEscrowId = new Map(escrows.map((escrow) => [escrow.id, escrow.milestones]));
  return notifications.filter((notification) => {
    if (!["Agreement changes requested", "Milestone changes requested", "Milestone resubmitted", "Milestone needs revision"].includes(notification.label)) {
      return true;
    }
    if (notification.txId === null) {
      return true;
    }
    const milestones = milestonesByEscrowId.get(notification.txId);
    return milestones ? isMilestoneNotificationStillActionable(notification, milestones) : true;
  });
}

export async function dismissNotification(prisma: PrismaClient, userId: string, notificationId: string) {
  const result = await prisma.notification.updateMany({
    where: { id: notificationId, userId, dismissedAt: null },
    data: { dismissedAt: new Date() },
  });
  if (result.count === 0) {
    throw new AppError("Notification not found.", 404);
  }
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
