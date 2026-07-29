import type { PrismaClient } from "@prisma/client";
import { buildNotificationId } from "../utils/id";
import { AppError } from "../utils/errors";
import { executeIdempotentCommand } from "./idempotencyService";
import { recordAuditEvent } from "./operationsService";
import { getNextSequenceValue } from "./sequenceService";

type EscrowParty = {
  id: string;
  name: string;
  role: "buyer" | "seller";
};

function requireAttachedParty(
  escrow: { buyerId: string | null; sellerId: string | null },
  userId: string,
) {
  if (escrow.buyerId !== userId && escrow.sellerId !== userId) {
    throw new AppError("Only the buyer or seller can access this conversation.", 403);
  }
}

function participantsForEscrow(escrow: {
  buyer: { id: string; name: string } | null;
  seller: { id: string; name: string } | null;
}): EscrowParty[] {
  return [
    ...(escrow.buyer ? [{ ...escrow.buyer, role: "buyer" as const }] : []),
    ...(escrow.seller ? [{ ...escrow.seller, role: "seller" as const }] : []),
  ];
}

function mapMessage(
  message: {
    id: number;
    body: string;
    createdAt: Date;
    sender: { id: string; name: string };
  },
  escrow: { buyerId: string | null },
) {
  return {
    id: message.id,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    sender: {
      id: message.sender.id,
      name: message.sender.name,
      role: message.sender.id === escrow.buyerId ? "buyer" : "seller",
    },
  };
}

export async function listEscrowMessages(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  options: { beforeId?: number; limit: number },
) {
  const escrow = await prisma.escrow.findUnique({
    where: { reference },
    include: {
      buyer: { select: { id: true, name: true } },
      seller: { select: { id: true, name: true } },
    },
  });
  if (!escrow) throw new AppError("Escrow not found.", 404);
  requireAttachedParty(escrow, userId);

  const newestFirst = await prisma.escrowMessage.findMany({
    where: {
      escrowId: escrow.id,
      ...(options.beforeId ? { id: { lt: options.beforeId } } : {}),
    },
    include: { sender: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit,
  });
  const messages = newestFirst.reverse().map((message) => mapMessage(message, escrow));
  const canSend = Boolean(escrow.buyerId && escrow.sellerId);

  return {
    escrowId: escrow.reference,
    participants: participantsForEscrow(escrow),
    canSend,
    unavailableReason: canSend
      ? null
      : "Chat becomes available when the invited counterparty joins and verifies their account.",
    messages,
    nextCursor: newestFirst.length === options.limit ? messages[0]?.id ?? null : null,
  };
}

export async function sendEscrowMessage(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  body: string,
  idempotencyKey: string,
) {
  const messageBody = body.trim();
  if (!messageBody) throw new AppError("Message cannot be empty.", 400);
  if (messageBody.length > 5_000) {
    throw new AppError("Message must be 5,000 characters or fewer.", 400);
  }

  return executeIdempotentCommand(
    prisma,
    {
      userId,
      key: idempotencyKey,
      command: "send_escrow_message",
      payload: { reference, body: messageBody },
    },
    async (tx) => {
      const escrow = await tx.escrow.findUnique({
        where: { reference },
        include: {
          buyer: { select: { id: true, name: true } },
          seller: { select: { id: true, name: true } },
        },
      });
      if (!escrow) throw new AppError("Escrow not found.", 404);
      requireAttachedParty(escrow, userId);

      const recipientId = escrow.buyerId === userId ? escrow.sellerId : escrow.buyerId;
      if (!recipientId) {
        throw new AppError(
          "Chat becomes available when the invited counterparty joins and verifies their account.",
          409,
        );
      }
      const sender = escrow.buyerId === userId ? escrow.buyer : escrow.seller;
      if (!sender) throw new AppError("Escrow party not found.", 409);

      const message = await tx.escrowMessage.create({
        data: {
          escrowId: escrow.id,
          senderId: userId,
          body: messageBody,
        },
        include: { sender: { select: { id: true, name: true } } },
      });
      await tx.notification.create({
        data: {
          id: buildNotificationId(await getNextSequenceValue(tx, "notification", 1)),
          userId: recipientId,
          label: "New escrow message",
          detail: `${sender.name} sent a message about ${escrow.title}.`,
          meta: "Just now",
          txId: escrow.id,
        },
      });
      await recordAuditEvent(tx, {
        dedupeKey: `escrow-message:${message.id}`,
        escrowId: escrow.id,
        actorId: userId,
        actorType: "user",
        action: "escrow_message.sent",
        entityType: "escrow_message",
        entityId: String(message.id),
        outcome: "completed",
        metadata: { characterCount: messageBody.length },
      });

      return {
        escrowId: escrow.reference,
        message: mapMessage(message, escrow),
      };
    },
  );
}
