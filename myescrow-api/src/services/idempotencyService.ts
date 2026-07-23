import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function requestHash(command: string, payload: unknown) {
  return createHash("sha256")
    .update(JSON.stringify({ command, payload: canonicalize(payload) }))
    .digest("hex");
}

function validateReplay(
  record: { command: string; requestHash: string; responseJson: Prisma.JsonValue | null },
  command: string,
  hash: string,
) {
  if (record.command !== command || record.requestHash !== hash) {
    throw new AppError("This idempotency key was already used for a different request.", 409);
  }
  if (record.responseJson === null) {
    throw new AppError("This request is still being processed. Retry shortly with the same idempotency key.", 409);
  }
  return record.responseJson;
}

export async function executeIdempotentCommand<T extends Prisma.JsonObject>(
  prisma: PrismaClient,
  input: {
    userId: string;
    key: string;
    command: string;
    payload: unknown;
  },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const result = await executeIdempotentCommandWithMetadata(prisma, input, operation);
  return result.value;
}

export async function executeIdempotentCommandWithMetadata<T extends Prisma.JsonObject>(
  prisma: PrismaClient,
  input: {
    userId: string;
    key: string;
    command: string;
    payload: unknown;
  },
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const hash = requestHash(input.command, input.payload);
  const unique = { userId_key: { userId: input.userId, key: input.key } };
  const existing = await prisma.idempotencyRecord.findUnique({ where: unique });
  if (existing) {
    await prisma.idempotencyRecord.update({
      where: { id: existing.id },
      data: { replayCount: { increment: 1 }, lastReplayedAt: new Date() },
    });
    return { value: validateReplay(existing, input.command, hash) as T, replayed: true };
  }

  try {
    const value = await prisma.$transaction(async (tx) => {
      const record = await tx.idempotencyRecord.create({
        data: {
          userId: input.userId,
          key: input.key,
          command: input.command,
          requestHash: hash,
        },
      });
      const response = await operation(tx);
      await tx.idempotencyRecord.update({
        where: { id: record.id },
        data: { responseJson: response as Prisma.InputJsonObject },
      });
      return response;
    });
    return { value, replayed: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const replay = await prisma.idempotencyRecord.findUnique({ where: unique });
      if (replay) {
        await prisma.idempotencyRecord.update({
          where: { id: replay.id },
          data: { replayCount: { increment: 1 }, lastReplayedAt: new Date() },
        });
        return { value: validateReplay(replay, input.command, hash) as T, replayed: true };
      }
    }
    throw error;
  }
}
