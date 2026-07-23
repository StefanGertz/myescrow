import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { sendEscrowInvitationEmail } from "./emailService";
import { AppError } from "../utils/errors";

const INVITATION_DAYS = 14;
const RESPONSE_DAYS = 7;
const MAX_ATTEMPTS = 5;

const addDays = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

export type InvitationPayload = {
  to: string;
  recipientName: string;
  creatorName: string;
  escrowTitle: string;
  escrowReference: string;
  creatorRole: "buyer" | "seller";
  invitationStatus: "existing_user" | "signup_required" | "verification_required";
};

export async function extendInvitationDelivery(
  tx: Prisma.TransactionClient,
  deliveryId: number,
  days: number,
) {
  const delivery = await tx.invitationDelivery.findUnique({
    where: { id: deliveryId },
    include: { escrow: { select: { lifecycleStatus: true, buyerId: true, sellerId: true, counterpartyEmail: true } } },
  });
  if (!delivery || ["accepted", "corrected"].includes(delivery.status)) {
    throw new AppError("No open invitation is available to extend.", 409);
  }
  const now = new Date();
  const base = delivery.expiresAt.getTime() > now.getTime() ? delivery.expiresAt : now;
  const expiresAt = addDays(base, days);
  await tx.escrow.update({
    where: { id: delivery.escrowId },
    data: {
      invitationExpiresAt: expiresAt,
      agreementResponseDueAt: expiresAt,
      ...(delivery.escrow.lifecycleStatus === "invitation_expired"
        ? delivery.escrow.buyerId && delivery.escrow.sellerId
          ? {
              lifecycleStatus: "pending_approval",
              stage: "Approval pending",
              dueDescription: `Waiting for ${delivery.recipient} to approve`,
              status: "warning",
            }
          : {
              lifecycleStatus: "pending_counterparty_signup",
              stage: "Invitation pending",
              dueDescription: `Waiting for ${delivery.escrow.counterpartyEmail} to create and verify an account`,
              status: "warning",
            }
        : {}),
    },
  });
  return tx.invitationDelivery.update({
    where: { id: delivery.id },
    data: { expiresAt, responseDueAt: expiresAt, status: delivery.status === "failed" ? "failed" : "delivered" },
  });
}

export async function queueEscrowInvitation(
  tx: Prisma.TransactionClient,
  input: { escrowId: number; payload: InvitationPayload; now?: Date; supersedeExisting?: boolean },
) {
  const now = input.now ?? new Date();
  if (input.supersedeExisting) {
    await tx.outboxEvent.updateMany({
      where: {
        invitationDelivery: { escrowId: input.escrowId },
        status: "pending",
      },
      data: { status: "cancelled", processedAt: now },
    });
    await tx.invitationDelivery.updateMany({
      where: { escrowId: input.escrowId, supersededAt: null, status: { not: "accepted" } },
      data: { status: "corrected", supersededAt: now },
    });
  }
  const expiresAt = addDays(now, INVITATION_DAYS);
  const responseDueAt = addDays(now, RESPONSE_DAYS);
  const delivery = await tx.invitationDelivery.create({
    data: {
      escrowId: input.escrowId,
      recipient: input.payload.to,
      expiresAt,
      responseDueAt,
      nextAttemptAt: now,
    },
  });
  await tx.outboxEvent.create({
    data: {
      invitationDeliveryId: delivery.id,
      eventType: "escrow_invitation",
      payload: input.payload as unknown as Prisma.InputJsonObject,
    },
  });
  await tx.escrow.update({
    where: { id: input.escrowId },
    data: { invitationExpiresAt: expiresAt, agreementResponseDueAt: responseDueAt },
  });
  return delivery;
}

export async function markInvitationAccepted(
  tx: Prisma.TransactionClient,
  escrowId: number,
) {
  await tx.outboxEvent.updateMany({
    where: { invitationDelivery: { escrowId }, status: "pending" },
    data: { status: "cancelled", processedAt: new Date() },
  });
  await tx.invitationDelivery.updateMany({
    where: { escrowId, supersededAt: null, status: { in: ["queued", "delivered", "failed"] } },
    data: { status: "accepted", acceptedAt: new Date(), nextAttemptAt: null, failureReason: null },
  });
}

export async function processInvitationOutbox(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
  limit = 10,
) {
  const events = await prisma.outboxEvent.findMany({
    where: { status: "pending", nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let delivered = 0;
  let failed = 0;
  for (const event of events) {
    const claimed = await prisma.outboxEvent.updateMany({
      where: { id: event.id, status: "pending" },
      data: { status: "processing" },
    });
    if (claimed.count !== 1) continue;
    try {
      const providerId = await sendEscrowInvitationEmail({
        ...(event.payload as InvitationPayload),
        logger,
      });
      await prisma.$transaction([
        prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: "completed", providerId, processedAt: new Date(), lastError: null },
        }),
        prisma.invitationDelivery.updateMany({
          where: {
            id: event.invitationDeliveryId,
            status: { in: ["queued", "failed"] },
          },
          data: {
            status: "delivered",
            providerId,
            attemptCount: { increment: 1 },
            nextAttemptAt: null,
            failureReason: null,
          },
        }),
      ]);
      delivered += 1;
    } catch (error) {
      const attempts = event.attemptCount + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const message = error instanceof Error ? error.message : "Unknown invitation delivery error";
      const nextAttemptAt = terminal
        ? null
        : new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000);
      await prisma.$transaction([
        prisma.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: terminal ? "failed" : "pending",
            attemptCount: attempts,
            nextAttemptAt: nextAttemptAt ?? event.nextAttemptAt,
            lastError: message,
          },
        }),
        prisma.invitationDelivery.updateMany({
          where: {
            id: event.invitationDeliveryId,
            status: { in: ["queued", "failed"] },
          },
          data: {
            status: "failed",
            attemptCount: attempts,
            nextAttemptAt,
            failureReason: message,
          },
        }),
      ]);
      failed += 1;
    }
  }
  return { processed: delivered + failed, delivered, failed };
}
