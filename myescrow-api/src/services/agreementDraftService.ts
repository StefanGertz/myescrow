import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";

type AgreementDraftRecord = {
  schemaVersion: number;
  data: Prisma.JsonValue | null;
  revision: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type DraftDatabaseClient = PrismaClient | Prisma.TransactionClient;

const draftConflict = () => new AppError(
  "This agreement draft changed in another session. Reload it before saving again.",
  409,
);

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const isIdempotentTombstone = (draft: AgreementDraftRecord | null, baseRevision: number) =>
  Boolean(
    draft
    && draft.data === null
    && draft.deletedAt
    && (baseRevision === draft.revision || baseRevision + 1 === draft.revision),
  );

export function agreementDraftResponse(draft: AgreementDraftRecord | null) {
  if (!draft?.data || Array.isArray(draft.data) || typeof draft.data !== "object") return null;

  return {
    schemaVersion: draft.schemaVersion,
    ...(draft.data as Prisma.JsonObject),
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export function agreementDraftStateResponse(draft: AgreementDraftRecord | null) {
  return {
    draft: agreementDraftResponse(draft),
    revision: draft?.revision ?? 0,
  };
}

export async function getAgreementDraft(prisma: DraftDatabaseClient, userId: string) {
  return prisma.escrowCreationDraft.findUnique({ where: { userId } });
}

export async function saveAgreementDraft(
  prisma: PrismaClient,
  userId: string,
  input: {
    baseRevision: number;
    schemaVersion: number;
    data: Prisma.InputJsonObject;
  },
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.escrowCreationDraft.updateMany({
        where: { userId, revision: input.baseRevision },
        data: {
          schemaVersion: input.schemaVersion,
          data: input.data,
          deletedAt: null,
          revision: { increment: 1 },
        },
      });
      if (updated.count === 1) {
        return tx.escrowCreationDraft.findUniqueOrThrow({ where: { userId } });
      }
      if (input.baseRevision !== 0) throw draftConflict();

      return tx.escrowCreationDraft.create({
        data: {
          userId,
          schemaVersion: input.schemaVersion,
          data: input.data,
          revision: 1,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw draftConflict();
    throw error;
  }
}

export async function tombstoneAgreementDraft(
  prisma: PrismaClient,
  userId: string,
  baseRevision: number,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await getAgreementDraft(tx, userId);
      if (!current) {
        if (baseRevision !== 0) throw draftConflict();
        return tx.escrowCreationDraft.create({
          data: {
            userId,
            data: Prisma.DbNull,
            deletedAt: new Date(),
            revision: 1,
          },
        });
      }
      if (isIdempotentTombstone(current, baseRevision)) return current;
      if (current.revision !== baseRevision) throw draftConflict();

      const deleted = await tx.escrowCreationDraft.updateMany({
        where: { userId, revision: baseRevision },
        data: {
          data: Prisma.DbNull,
          deletedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (deleted.count === 1) {
        return tx.escrowCreationDraft.findUniqueOrThrow({ where: { userId } });
      }

      const raced = await getAgreementDraft(tx, userId);
      if (isIdempotentTombstone(raced, baseRevision)) return raced!;
      throw draftConflict();
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const raced = await getAgreementDraft(prisma, userId);
      if (isIdempotentTombstone(raced, baseRevision)) return raced!;
      throw draftConflict();
    }
    throw error;
  }
}

export async function consumeAgreementDraftForCreate(
  tx: Prisma.TransactionClient,
  userId: string,
  draftRevision: number | undefined,
) {
  const consumed = await tx.escrowCreationDraft.updateMany({
    where: {
      userId,
      ...(draftRevision === undefined
        ? { deletedAt: { not: null } }
        : { revision: draftRevision }),
    },
    data: {
      data: Prisma.DbNull,
      deletedAt: new Date(),
      revision: { increment: 1 },
    },
  });
  if (consumed.count === 1) {
    return tx.escrowCreationDraft.findUniqueOrThrow({ where: { userId } });
  }
  if (draftRevision !== undefined && draftRevision !== 0) throw draftConflict();

  try {
    return await tx.escrowCreationDraft.create({
      data: {
        userId,
        data: Prisma.DbNull,
        deletedAt: new Date(),
        revision: 1,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) throw draftConflict();
    throw error;
  }
}
