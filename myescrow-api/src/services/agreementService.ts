import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { AppError } from "../utils/errors";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export type AgreementTerms = {
  title: string;
  description: string | null;
  amountCents: number;
  creatorRole: string;
  creatorParty: Prisma.InputJsonValue;
  counterpartyParty?: Prisma.InputJsonValue | null;
  milestones: Array<{
    milestoneId?: number;
    title: string;
    description: string | null;
    amountCents: number;
    deadline: string | null;
    orderIndex: number;
  }>;
};

export async function createAgreementVersion(
  tx: Prisma.TransactionClient,
  input: { escrowId: number; createdById: string; terms: AgreementTerms },
) {
  const latest = await tx.agreementVersion.findFirst({
    where: { escrowId: input.escrowId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  await tx.agreementVersion.updateMany({
    where: { escrowId: input.escrowId, status: { in: ["current", "locked"] } },
    data: { status: "superseded" },
  });
  const version = await tx.agreementVersion.create({
    data: {
      escrowId: input.escrowId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      termsHash: hash(input.terms),
      title: input.terms.title,
      description: input.terms.description,
      amountCents: input.terms.amountCents,
      creatorRole: input.terms.creatorRole,
      creatorParty: input.terms.creatorParty,
      ...(input.terms.counterpartyParty
        ? { counterpartyParty: input.terms.counterpartyParty }
        : {}),
      milestones: input.terms.milestones as unknown as Prisma.InputJsonArray,
      createdById: input.createdById,
    },
  });
  await tx.escrow.update({
    where: { id: input.escrowId },
    data: {
      currentAgreementVersionId: version.id,
      counterpartyApproved: false,
      approvedAt: null,
      creatorSignatureDataUrl: null,
      counterpartySignatureDataUrl: null,
    },
  });
  return version;
}

export async function signAgreementVersion(
  tx: Prisma.TransactionClient,
  input: {
    agreementVersionId: number;
    signerId: string;
    signerRole: "buyer" | "seller";
    signatureDataUrl: string;
  },
) {
  const version = await tx.agreementVersion.findUnique({
    where: { id: input.agreementVersionId },
  });
  if (!version || version.status === "superseded") {
    throw new AppError("This agreement version is no longer available for signing.", 409);
  }
  return tx.agreementSignature.upsert({
    where: {
      agreementVersionId_signerId: {
        agreementVersionId: input.agreementVersionId,
        signerId: input.signerId,
      },
    },
    create: {
      agreementVersionId: input.agreementVersionId,
      signerId: input.signerId,
      signerRole: input.signerRole,
      signatureDataUrl: input.signatureDataUrl,
      evidenceHash: hash({
        termsHash: version.termsHash,
        signerId: input.signerId,
        signerRole: input.signerRole,
        signatureDataUrl: input.signatureDataUrl,
      }),
    },
    update: {
      signerRole: input.signerRole,
      signatureDataUrl: input.signatureDataUrl,
      evidenceHash: hash({
        termsHash: version.termsHash,
        signerId: input.signerId,
        signerRole: input.signerRole,
        signatureDataUrl: input.signatureDataUrl,
      }),
      signedAt: new Date(),
    },
  });
}

export async function lockAgreementIfFullySigned(
  tx: Prisma.TransactionClient,
  input: { agreementVersionId: number; buyerId: string; sellerId: string },
) {
  const signatures = await tx.agreementSignature.findMany({
    where: { agreementVersionId: input.agreementVersionId },
    select: { signerId: true },
  });
  const signers = new Set(signatures.map((signature) => signature.signerId));
  if (!signers.has(input.buyerId) || !signers.has(input.sellerId)) {
    throw new AppError("Both parties must sign the current agreement version before funding.", 409);
  }
  return tx.agreementVersion.update({
    where: { id: input.agreementVersionId },
    data: { status: "locked", lockedAt: new Date() },
  });
}

export async function assertFundableAgreement(
  tx: Prisma.TransactionClient,
  input: { currentAgreementVersionId: number | null; buyerId: string; sellerId: string },
) {
  if (!input.currentAgreementVersionId) {
    throw new AppError("This escrow does not have a current agreement version.", 409);
  }
  const version = await tx.agreementVersion.findUnique({
    where: { id: input.currentAgreementVersionId },
    include: { signatures: { select: { signerId: true } } },
  });
  const signers = new Set(version?.signatures.map((signature) => signature.signerId) ?? []);
  if (
    !version
    || version.status !== "locked"
    || !version.lockedAt
    || !signers.has(input.buyerId)
    || !signers.has(input.sellerId)
  ) {
    throw new AppError("Both parties must sign the locked current agreement version before funding.", 409);
  }
  return version;
}
