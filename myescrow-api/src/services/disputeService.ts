import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";
import {
  buildCancellationReference,
  buildDisputeReference,
  buildNotificationId,
} from "../utils/id";
import { executeIdempotentCommand } from "./idempotencyService";
import { applyEscrowTransfer, getEscrowLedgerBalances } from "./moneyIntegrityService";
import { getNextSequenceValue } from "./sequenceService";

const ACTIVE_DISPUTE_STATUSES = ["open", "resolution_proposed", "resolving", "arbitration_requested"];
const TERMINAL_MILESTONE_STATUSES = ["released", "refunded", "settled", "cancelled"];
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

export type EvidenceReferenceInput = {
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

async function notify(
  tx: Prisma.TransactionClient,
  userId: string,
  label: string,
  detail: string,
  escrowId: number,
) {
  await tx.notification.create({
    data: {
      id: buildNotificationId(await getNextSequenceValue(tx, "notification", 1)),
      userId,
      label,
      detail,
      meta: "Just now",
      txId: escrowId,
    },
  });
}

function requireEscrowParty(
  escrow: { buyerId: string | null; sellerId: string | null },
  userId: string,
) {
  if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
    throw new AppError("Only the buyer or seller can perform this action.", 403);
  }
}

function otherPartyId(
  escrow: { buyerId: string | null; sellerId: string | null },
  userId: string,
) {
  const otherId = escrow.buyerId === userId ? escrow.sellerId : escrow.buyerId;
  if (!otherId) throw new AppError("Both escrow parties must be attached before this action.", 409);
  return otherId;
}

export async function openMilestoneDispute(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  reason: string,
  idempotencyKey: string,
) {
  const disputeReason = reason.trim();
  if (disputeReason.length < 10) {
    throw new AppError("Describe the dispute in at least 10 characters.", 400);
  }

  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "open_milestone_dispute",
      payload: { reference, milestoneId, reason: disputeReason },
    },
    async (tx) => {
      const escrow = await tx.escrow.findUnique({
        where: { reference },
        include: {
          buyer: true,
          seller: true,
          milestones: { include: { ledgerEntries: true } },
        },
      });
      if (!escrow) throw new AppError("Escrow not found.", 404);
      requireEscrowParty(escrow, userId);
      if (escrow.lifecycleStatus !== "funded") {
        throw new AppError("A milestone dispute can only be opened while the escrow is funded.", 409);
      }
      const milestone = escrow.milestones.find((item) => item.id === milestoneId);
      if (!milestone) throw new AppError("Milestone not found.", 404);
      if (!["submitted", "revision_requested"].includes(milestone.status)) {
        throw new AppError("Only submitted or revision-requested work can be disputed.", 409);
      }
      const alreadyAllocated = milestone.ledgerEntries
        .filter((entry) => entry.amountCents < 0)
        .reduce((total, entry) => total + Math.abs(entry.amountCents), 0);
      const remainingCents = milestone.amountCents - alreadyAllocated;
      if (remainingCents <= 0) {
        throw new AppError("This milestone has no remaining held balance to dispute.", 409);
      }

      const transition = await tx.escrowMilestone.updateMany({
        where: { id: milestone.id, status: milestone.status },
        data: {
          status: "disputed",
          reviewDeadline: null,
          reminderAt: null,
        },
      });
      if (transition.count !== 1) {
        throw new AppError("This milestone changed before the dispute opened. Refresh and try again.", 409);
      }

      const sequence = await getNextSequenceValue(tx, "dispute", 1);
      const evidenceWindowEndsAt = addDays(new Date(), 7);
      const opener = escrow.buyerId === userId ? escrow.buyer : escrow.seller;
      const dispute = await tx.dispute.create({
        data: {
          reference: buildDisputeReference(sequence),
          ownerId: userId,
          escrowId: escrow.id,
          milestoneId: milestone.id,
          openedById: userId,
          title: `${escrow.title}: ${milestone.title}`,
          ownerTeam: opener?.name ?? "Escrow party",
          amountCents: remainingCents,
          amountFrozenCents: remainingCents,
          reason: disputeReason,
          evidenceWindowEndsAt,
          resolutionAuthority: "mutual_party_agreement",
          updatedLabel: "Evidence window open",
          priority: remainingCents >= 2_500_000 ? "high" : "medium",
          status: "open",
          workspaceLaunched: true,
        },
      });
      await tx.escrow.update({
        where: { id: escrow.id },
        data: {
          stage: "Milestone disputed",
          dueDescription: `Evidence due ${evidenceWindowEndsAt.toLocaleDateString("en-US")}`,
          status: "warning",
        },
      });
      await notify(
        tx,
        otherPartyId(escrow, userId),
        "Milestone dispute opened",
        `${milestone.title} has ${remainingCents / 100} USD reserved while both parties submit evidence.`,
        escrow.id,
      );
      return {
        success: true,
        disputeId: dispute.reference,
        escrowId: escrow.reference,
        milestoneId: milestone.id,
        amountFrozenCents: remainingCents,
        evidenceWindowEndsAt: evidenceWindowEndsAt.toISOString(),
      };
    },
  );
}

export async function submitDisputeEvidence(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  input: { note?: string | undefined; evidence?: EvidenceReferenceInput[] | undefined },
  idempotencyKey: string,
) {
  const note = input.note?.trim() || null;
  const evidence = input.evidence ?? [];
  if (!note && evidence.length === 0) {
    throw new AppError("Add an evidence note or at least one evidence reference.", 400);
  }
  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "submit_dispute_evidence",
      payload: { reference, note, evidence },
    },
    async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { reference },
        include: { escrow: true },
      });
      if (!dispute?.escrow) throw new AppError("Dispute not found.", 404);
      requireEscrowParty(dispute.escrow, userId);
      if (!["open", "resolution_proposed"].includes(dispute.status)) {
        throw new AppError("This dispute is no longer accepting evidence.", 409);
      }
      if (dispute.evidenceWindowEndsAt && dispute.evidenceWindowEndsAt < new Date()) {
        throw new AppError("The evidence window has closed.", 409);
      }
      const submission = await tx.disputeEvidenceSubmission.create({
        data: {
          disputeId: dispute.id,
          submitterId: userId,
          note,
          evidence,
        },
      });
      await notify(
        tx,
        otherPartyId(dispute.escrow, userId),
        "Dispute evidence added",
        `New evidence was added to ${dispute.reference}.`,
        dispute.escrow.id,
      );
      return { success: true, disputeId: dispute.reference, evidenceSubmissionId: submission.id };
    },
  );
}

export async function requestDisputeArbitration(
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
      command: "request_dispute_arbitration",
      payload: { reference },
    },
    async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { reference },
        include: { escrow: true, _count: { select: { evidenceSubmissions: true } } },
      });
      if (!dispute?.escrow) throw new AppError("Dispute not found.", 404);
      requireEscrowParty(dispute.escrow, userId);
      if (dispute._count.evidenceSubmissions === 0) {
        throw new AppError("Submit evidence before requesting arbitration.", 409);
      }
      if (!["open", "resolution_proposed"].includes(dispute.status)) {
        throw new AppError(
          dispute.status === "arbitration_requested"
            ? "Arbitration has already been requested."
            : "This dispute can no longer be moved to arbitration.",
          409,
        );
      }

      const requestedAt = new Date();
      const transition = await tx.dispute.updateMany({
        where: { id: dispute.id, status: { in: ["open", "resolution_proposed"] } },
        data: {
          status: "arbitration_requested",
          resolutionAuthority: "arbitration",
          arbitrationRequestedAt: requestedAt,
          arbitrationRequestedById: userId,
          resolutionProposedById: null,
          proposedSellerCents: null,
          proposedBuyerCents: null,
          resolutionNote: null,
          updatedLabel: "Arbitration requested",
        },
      });
      if (transition.count !== 1) {
        throw new AppError("The dispute changed before arbitration was requested. Refresh and try again.", 409);
      }
      await tx.escrow.update({
        where: { id: dispute.escrow.id },
        data: {
          stage: "Dispute in arbitration",
          dueDescription: "Arbitration review pending",
          status: "warning",
        },
      });
      await notify(
        tx,
        otherPartyId(dispute.escrow, userId),
        "Arbitration requested",
        `${dispute.reference} has moved to arbitration. The disputed funds remain reserved.`,
        dispute.escrow.id,
      );
      return {
        success: true,
        disputeId: dispute.reference,
        status: "arbitration_requested",
        arbitrationRequestedAt: requestedAt.toISOString(),
      };
    },
  );
}

export async function proposeDisputeResolution(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  sellerCents: number,
  buyerCents: number,
  note: string | undefined,
  idempotencyKey: string,
) {
  if (!Number.isInteger(sellerCents) || !Number.isInteger(buyerCents) || sellerCents < 0 || buyerCents < 0) {
    throw new AppError("Resolution allocations must be non-negative whole cents.", 400);
  }
  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "propose_dispute_resolution",
      payload: { reference, sellerCents, buyerCents, note: note?.trim() || null },
    },
    async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { reference },
        include: { escrow: true },
      });
      if (!dispute?.escrow) throw new AppError("Dispute not found.", 404);
      requireEscrowParty(dispute.escrow, userId);
      if (sellerCents + buyerCents !== dispute.amountFrozenCents) {
        throw new AppError("Seller and buyer allocations must equal the full frozen amount.", 400);
      }
      if (
        dispute.status !== "open"
        && !(dispute.status === "resolution_proposed" && dispute.resolutionProposedById === userId)
      ) {
        throw new AppError("The other party must accept or decline the current resolution proposal.", 409);
      }
      const transition = await tx.dispute.updateMany({
        where: {
          id: dispute.id,
          OR: [
            { status: "open" },
            { status: "resolution_proposed", resolutionProposedById: userId },
          ],
        },
        data: {
          status: "resolution_proposed",
          resolutionProposedById: userId,
          proposedSellerCents: sellerCents,
          proposedBuyerCents: buyerCents,
          resolutionNote: note?.trim() || null,
          updatedLabel: "Mutual resolution proposed",
        },
      });
      if (transition.count !== 1) {
        throw new AppError("The dispute changed before this proposal was saved. Refresh and try again.", 409);
      }
      await notify(
        tx,
        otherPartyId(dispute.escrow, userId),
        "Dispute resolution proposed",
        `${dispute.reference} has a complete allocation proposal awaiting your acceptance.`,
        dispute.escrow.id,
      );
      return { success: true, disputeId: dispute.reference, status: "resolution_proposed" };
    },
  );
}

export async function acceptDisputeResolution(
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
      command: "accept_dispute_resolution",
      payload: { reference },
    },
    async (tx) => {
      const dispute = await tx.dispute.findUnique({
        where: { reference },
        include: { escrow: true, milestone: true },
      });
      if (!dispute?.escrow || !dispute.milestone) throw new AppError("Dispute not found.", 404);
      requireEscrowParty(dispute.escrow, userId);
      if (dispute.status !== "resolution_proposed" || !dispute.resolutionProposedById) {
        throw new AppError("This dispute does not have a resolution proposal to accept.", 409);
      }
      if (dispute.resolutionProposedById === userId) {
        throw new AppError("The other party must accept this resolution proposal.", 403);
      }
      const sellerCents = dispute.proposedSellerCents ?? -1;
      const buyerCents = dispute.proposedBuyerCents ?? -1;
      if (sellerCents < 0 || buyerCents < 0 || sellerCents + buyerCents !== dispute.amountFrozenCents) {
        throw new AppError("The proposed allocations do not reconcile to the frozen amount.", 409);
      }
      const transition = await tx.dispute.updateMany({
        where: { id: dispute.id, status: "resolution_proposed" },
        data: { status: "resolving" },
      });
      if (transition.count !== 1) {
        throw new AppError("This dispute was already processed. Refresh and try again.", 409);
      }
      if (!dispute.escrow.sellerId || !dispute.escrow.buyerId) {
        throw new AppError("Both escrow parties must be attached before resolution.", 409);
      }

      if (sellerCents > 0) {
        const transfer = await applyEscrowTransfer(tx, {
          escrowId: dispute.escrow.id,
          milestoneId: dispute.milestone.id,
          movementType: "settlement_release",
          amountCents: sellerCents,
          idempotencyKey: `${idempotencyKey}:seller`,
          businessReference: `dispute:${dispute.reference}:seller`,
          actorId: userId,
          sourceCommand: "accept_dispute_resolution",
          walletUserId: dispute.escrow.sellerId,
        });
        await tx.disputeResolutionAllocation.create({
          data: {
            disputeId: dispute.id,
            recipient: "seller",
            amountCents: sellerCents,
            ledgerEntryId: transfer.entry.id,
          },
        });
      }
      if (buyerCents > 0) {
        const transfer = await applyEscrowTransfer(tx, {
          escrowId: dispute.escrow.id,
          milestoneId: dispute.milestone.id,
          movementType: "settlement_refund",
          amountCents: buyerCents,
          idempotencyKey: `${idempotencyKey}:buyer`,
          businessReference: `dispute:${dispute.reference}:buyer`,
          actorId: userId,
          sourceCommand: "accept_dispute_resolution",
          walletUserId: dispute.escrow.buyerId,
        });
        await tx.disputeResolutionAllocation.create({
          data: {
            disputeId: dispute.id,
            recipient: "buyer",
            amountCents: buyerCents,
            ledgerEntryId: transfer.entry.id,
          },
        });
      }
      const milestoneStatus = sellerCents === dispute.amountFrozenCents
        ? "released"
        : buyerCents === dispute.amountFrozenCents
          ? "refunded"
          : "settled";
      await tx.escrowMilestone.update({
        where: { id: dispute.milestone.id },
        data: {
          status: milestoneStatus,
          ...(milestoneStatus === "released" ? { releasedAt: new Date() } : {}),
        },
      });
      await tx.dispute.update({
        where: { id: dispute.id },
        data: {
          status: "resolved",
          resolvedAt: new Date(),
          updatedLabel: "Resolved by mutual agreement",
        },
      });
      const balances = await getEscrowLedgerBalances(tx, dispute.escrow.id);
      const remainingMilestones = await tx.escrowMilestone.count({
        where: {
          escrowId: dispute.escrow.id,
          status: { notIn: TERMINAL_MILESTONE_STATUSES },
        },
      });
      const cancellation = await tx.cancellationRequest.findFirst({
        where: {
          escrowId: dispute.escrow.id,
          status: { in: ["pending", "processing", "accepted"] },
        },
        orderBy: { requestedAt: "desc" },
      });
      const escrowState = cancellation?.status === "accepted" && balances.heldCents === 0
        ? {
            lifecycleStatus: "cancelled",
            fundingStatus: sellerCents > 0 ? "settled" : "refunded",
            stage: "Cancelled and settled",
            dueDescription: "All remaining funds allocated",
            status: "warning",
            cancelledAt: new Date(),
          }
        : cancellation?.status === "pending"
          ? {
              lifecycleStatus: "cancellation_pending",
              stage: "Cancellation requested",
              dueDescription: "Waiting for counterparty response",
              status: "warning",
            }
          : balances.heldCents === 0 && remainingMilestones === 0
            ? {
                lifecycleStatus: "completed",
                stage: "Resolved and settled",
                dueDescription: "All funds allocated",
                status: "success",
              }
            : {
                lifecycleStatus: "funded",
                stage: "Milestones active",
                dueDescription: "Dispute resolved",
                status: "success",
              };
      await tx.escrow.update({
        where: { id: dispute.escrow.id },
        data: escrowState,
      });
      await notify(
        tx,
        dispute.resolutionProposedById,
        "Dispute resolved",
        `${dispute.reference} was accepted. Every frozen dollar has been allocated.`,
        dispute.escrow.id,
      );
      return {
        success: true,
        disputeId: dispute.reference,
        sellerCents,
        buyerCents,
        status: "resolved",
      };
    },
  );
}

export async function requestFundedCancellation(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  input: { mode: "mutual" | "unilateral"; reason: string },
  idempotencyKey: string,
) {
  const reason = input.reason.trim();
  if (reason.length < 10) throw new AppError("Explain the cancellation request in at least 10 characters.", 400);
  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "request_funded_cancellation",
      payload: { reference, mode: input.mode, reason },
    },
    async (tx) => {
      const escrow = await tx.escrow.findUnique({ where: { reference } });
      if (!escrow) throw new AppError("Escrow not found.", 404);
      requireEscrowParty(escrow, userId);
      if (escrow.lifecycleStatus !== "funded" || escrow.fundingStatus !== "funded") {
        throw new AppError("A funded cancellation request is not available in this escrow state.", 409);
      }
      const transition = await tx.escrow.updateMany({
        where: { id: escrow.id, lifecycleStatus: "funded", fundingStatus: "funded" },
        data: {
          lifecycleStatus: input.mode === "mutual" ? "cancellation_pending" : "cancellation_review",
          stage: input.mode === "mutual" ? "Cancellation requested" : "Cancellation under review",
          dueDescription: input.mode === "mutual"
            ? "Waiting for counterparty response"
            : "Funds held for governed review",
          status: "warning",
        },
      });
      if (transition.count !== 1) {
        throw new AppError("The escrow changed before cancellation could be requested.", 409);
      }
      const sequence = await getNextSequenceValue(tx, "cancellation", 1);
      const cancellation = await tx.cancellationRequest.create({
        data: {
          reference: buildCancellationReference(sequence),
          escrowId: escrow.id,
          requestedById: userId,
          mode: input.mode,
          reason,
          status: input.mode === "mutual" ? "pending" : "escalated",
        },
      });
      await notify(
        tx,
        otherPartyId(escrow, userId),
        input.mode === "mutual" ? "Mutual cancellation requested" : "Unilateral cancellation escalated",
        input.mode === "mutual"
          ? `${cancellation.reference} needs your response before any refund occurs.`
          : `${cancellation.reference} is in governed review. Funds remain held.`,
        escrow.id,
      );
      return {
        success: true,
        cancellationId: cancellation.reference,
        status: cancellation.status,
      };
    },
  );
}

export async function acceptFundedCancellation(
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
      command: "accept_funded_cancellation",
      payload: { reference },
    },
    async (tx) => {
      const cancellation = await tx.cancellationRequest.findUnique({
        where: { reference },
        include: { escrow: true },
      });
      if (!cancellation) throw new AppError("Cancellation request not found.", 404);
      requireEscrowParty(cancellation.escrow, userId);
      if (cancellation.mode !== "mutual" || cancellation.status !== "pending") {
        throw new AppError("This cancellation request cannot be accepted.", 409);
      }
      if (cancellation.requestedById === userId) {
        throw new AppError("The other party must accept a mutual cancellation.", 403);
      }
      const transition = await tx.cancellationRequest.updateMany({
        where: { id: cancellation.id, status: "pending" },
        data: { status: "processing" },
      });
      if (transition.count !== 1) {
        throw new AppError("This cancellation was already processed.", 409);
      }
      const balances = await getEscrowLedgerBalances(tx, cancellation.escrow.id);
      const refundableCents = balances.heldCents - balances.disputedCents;
      if (refundableCents < 0) throw new AppError("Disputed funds exceed the held escrow balance.", 409);
      if (!cancellation.escrow.buyerId) throw new AppError("Buyer account is not attached.", 409);

      let refundLedgerEntryId: number | null = null;
      if (refundableCents > 0) {
        const transfer = await applyEscrowTransfer(tx, {
          escrowId: cancellation.escrow.id,
          movementType: "refund",
          amountCents: refundableCents,
          idempotencyKey: `${idempotencyKey}:refund`,
          businessReference: `cancellation:${cancellation.reference}:refund`,
          actorId: userId,
          sourceCommand: "accept_funded_cancellation",
          walletUserId: cancellation.escrow.buyerId,
        });
        refundLedgerEntryId = transfer.entry.id;
      }
      await tx.escrowMilestone.updateMany({
        where: {
          escrowId: cancellation.escrow.id,
          status: { in: ["not_started", "submitted", "revision_requested"] },
        },
        data: { status: "cancelled", reviewDeadline: null, reminderAt: null },
      });
      await tx.cancellationRequest.update({
        where: { id: cancellation.id },
        data: {
          status: "accepted",
          respondedById: userId,
          respondedAt: new Date(),
          refundAmountCents: refundableCents,
          refundLedgerEntryId,
        },
      });
      const hasActiveDisputes = await tx.dispute.count({
        where: {
          escrowId: cancellation.escrow.id,
          status: { in: ACTIVE_DISPUTE_STATUSES },
        },
      });
      await tx.escrow.update({
        where: { id: cancellation.escrow.id },
        data: hasActiveDisputes > 0
          ? {
              lifecycleStatus: "dispute_resolution_pending",
              stage: "Cancellation accepted; dispute pending",
              dueDescription: "Only disputed funds remain held",
              status: "warning",
            }
          : {
              lifecycleStatus: "cancelled",
              fundingStatus: "refunded",
              stage: "Cancelled and refunded",
              dueDescription: "Unreleased funds returned to buyer",
              status: "warning",
              cancelledAt: new Date(),
            },
      });
      await notify(
        tx,
        cancellation.requestedById,
        "Mutual cancellation accepted",
        `${refundableCents / 100} USD of undisputed, unreleased funds was returned to the buyer.`,
        cancellation.escrow.id,
      );
      return {
        success: true,
        cancellationId: cancellation.reference,
        refundedCents: refundableCents,
        disputedCents: balances.disputedCents,
      };
    },
  );
}
