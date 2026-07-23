import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { buildNotificationId } from "../utils/id";
import { AppError } from "../utils/errors";
import { executeIdempotentCommand } from "./idempotencyService";
import { getNextSequenceValue } from "./sequenceService";

const REVIEW_DAYS = 7;
const REMINDER_DAYS = 5;

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

export type MilestoneEvidenceInput = {
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

export type MilestoneSubmissionInput = {
  note?: string | undefined;
  evidence?: MilestoneEvidenceInput[] | undefined;
};

function evidenceFingerprint(evidence: MilestoneEvidenceInput[]) {
  return createHash("sha256")
    .update(JSON.stringify(evidence.map((item) => ({
      objectKey: item.objectKey,
      fileName: item.fileName,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
    })).sort((left, right) => left.objectKey.localeCompare(right.objectKey))))
    .digest("hex");
}

async function createNotification(
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

export async function submitMilestoneWork(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  data: MilestoneSubmissionInput,
  idempotencyKey: string,
) {
  const note = data.note?.trim() || null;
  const evidence = data.evidence ?? [];
  if (!note && evidence.length === 0) {
    throw new AppError("Add a submission note or at least one evidence reference.", 400);
  }

  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "submit_milestone",
      payload: { reference, milestoneId, note, evidence },
    },
    async (tx) => {
      const escrow = await tx.escrow.findFirst({
        where: {
          reference,
          OR: [{ ownerId: userId }, { buyerId: userId }, { sellerId: userId }],
        },
        include: {
          milestones: {
            orderBy: { orderIndex: "asc" },
            include: {
              submissions: {
                orderBy: { submissionNumber: "desc" },
                take: 1,
                include: { evidence: true },
              },
            },
          },
        },
      });
      if (!escrow) throw new AppError("Escrow not found.", 404);
      if (escrow.sellerId !== userId) throw new AppError("Only the seller can submit milestone work.", 403);
      if (escrow.lifecycleStatus !== "funded") {
        throw new AppError("Milestone work can only be submitted after funding.", 400);
      }
      const milestone = escrow.milestones.find((item) => item.id === milestoneId);
      if (!milestone) throw new AppError("Milestone not found.", 404);
      if (!["not_started", "revision_requested"].includes(milestone.status)) {
        throw new AppError("This milestone is not awaiting a seller submission.", 409);
      }
      const blockedBy = escrow.milestones.find(
        (item) => item.orderIndex < milestone.orderIndex
          && !["released", "refunded", "settled", "cancelled"].includes(item.status),
      );
      if (blockedBy) {
        throw new AppError(`Complete the earlier milestone \"${blockedBy.title}\" first.`, 409);
      }

      const previous = milestone.submissions[0];
      if (previous) {
        const previousEvidence = previous.evidence.map((item) => ({
          objectKey: item.objectKey,
          fileName: item.fileName,
          contentType: item.contentType,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256,
        }));
        if (
          (previous.note?.trim() || null) === note
          && evidenceFingerprint(previousEvidence) === evidenceFingerprint(evidence)
        ) {
          throw new AppError("A resubmission needs a new note or changed evidence.", 400);
        }
      }

      const now = new Date();
      const reviewDeadline = addDays(now, REVIEW_DAYS);
      const reminderAt = addDays(now, REMINDER_DAYS);
      const transition = await tx.escrowMilestone.updateMany({
        where: { id: milestone.id, status: milestone.status },
        data: {
          status: "submitted",
          rejectedAt: null,
          reviewDeadline,
          reminderAt,
          reminderSentAt: null,
          reviewOverdueAt: null,
        },
      });
      if (transition.count !== 1) {
        throw new AppError("This milestone changed before it could be submitted. Refresh and try again.", 409);
      }

      const submission = await tx.milestoneSubmission.create({
        data: {
          milestoneId: milestone.id,
          submitterId: userId,
          submissionNumber: (previous?.submissionNumber ?? 0) + 1,
          note,
          reviewDeadline,
          reminderAt,
          evidence: { create: evidence },
        },
        include: { evidence: true },
      });
      if (!escrow.buyerId) throw new AppError("Buyer account is not attached to this escrow.", 409);
      await createNotification(
        tx,
        escrow.buyerId,
        previous ? "Milestone resubmitted" : "Milestone submitted",
        `${milestone.title} submission ${submission.submissionNumber} is ready for review by ${reviewDeadline.toLocaleDateString("en-US")}.`,
        escrow.id,
      );

      return {
        success: true,
        escrowId: escrow.reference,
        milestoneId: milestone.id,
        submissionId: submission.id,
        submissionNumber: submission.submissionNumber,
        reviewDeadline: reviewDeadline.toISOString(),
      };
    },
  );
}

export async function processMilestoneReviewDeadlines(
  prisma: PrismaClient,
  now = new Date(),
) {
  const reminders = await prisma.escrowMilestone.findMany({
    where: {
      status: "submitted",
      reminderAt: { lte: now },
      reminderSentAt: null,
      reviewDeadline: { gt: now },
    },
    include: { escrow: true },
  });
  const overdue = await prisma.escrowMilestone.findMany({
    where: {
      status: "submitted",
      reviewDeadline: { lte: now },
      reviewOverdueAt: null,
    },
    include: { escrow: true },
  });
  let remindersSent = 0;
  let escalated = 0;

  for (const milestone of reminders) {
    await prisma.$transaction(async (tx) => {
      const transition = await tx.escrowMilestone.updateMany({
        where: { id: milestone.id, status: "submitted", reminderSentAt: null },
        data: { reminderSentAt: now },
      });
      if (transition.count !== 1 || !milestone.escrow.buyerId) return;
      await createNotification(
        tx,
        milestone.escrow.buyerId,
        "Milestone review due soon",
        `${milestone.title} is awaiting your review. Funds remain held until you decide.`,
        milestone.escrow.id,
      );
      remindersSent += 1;
    });
  }

  for (const milestone of overdue) {
    await prisma.$transaction(async (tx) => {
      const transition = await tx.escrowMilestone.updateMany({
        where: { id: milestone.id, status: "submitted", reviewOverdueAt: null },
        data: { reviewOverdueAt: now, reminderSentAt: milestone.reminderSentAt ?? now },
      });
      if (transition.count !== 1) return;
      if (milestone.escrow.buyerId) {
        await createNotification(
          tx,
          milestone.escrow.buyerId,
          "Milestone review overdue",
          `${milestone.title} is overdue for review. Funds remain held; approve it or request a revision.`,
          milestone.escrow.id,
        );
      }
      if (milestone.escrow.sellerId) {
        await createNotification(
          tx,
          milestone.escrow.sellerId,
          "Milestone review overdue",
          `${milestone.title} has been escalated for buyer review. Its funds remain safely held.`,
          milestone.escrow.id,
        );
      }
      escalated += 1;
    });
  }

  return { remindersSent, escalated, policy: "hold_and_escalate" as const };
}
