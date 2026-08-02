import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";
import { readVerifiedEvidenceFile } from "./milestoneProofService";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function sha256(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

type EvidenceReference = {
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

function evidenceReferences(value: unknown): EvidenceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    const objectKey = typeof candidate.objectKey === "string" ? candidate.objectKey : "";
    const fileName = typeof candidate.fileName === "string" ? candidate.fileName : "";
    const contentType = typeof candidate.contentType === "string" ? candidate.contentType : "";
    const sizeBytes = typeof candidate.sizeBytes === "number" ? candidate.sizeBytes : 0;
    const referenceHash = typeof candidate.sha256 === "string" ? candidate.sha256.toLowerCase() : "";
    if (!fileName && !referenceHash) return [];
    return [{
      objectKey,
      fileName: fileName || "Unnamed evidence file",
      contentType,
      sizeBytes,
      sha256: referenceHash,
    }];
  });
}

export async function getArbitrationReport(
  prisma: PrismaClient,
  reference: string,
  partyUserId?: string,
) {
  const dispute = await prisma.dispute.findUnique({
    where: { reference },
    include: {
      openedBy: { select: { id: true, name: true, email: true } },
      arbitrationRequestedBy: { select: { id: true, name: true, email: true } },
      evidenceSubmissions: {
        include: {
          submitter: { select: { id: true, name: true, email: true } },
          files: { orderBy: { id: "asc" } },
        },
        orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      },
      milestone: {
        include: {
          submissions: {
            include: {
              submitter: { select: { id: true, name: true, email: true } },
              evidence: { orderBy: { id: "asc" } },
              review: {
                include: {
                  reviewer: { select: { id: true, name: true, email: true } },
                },
              },
            },
            orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
          },
        },
      },
      escrow: {
        include: {
          buyer: { select: { id: true, name: true, email: true } },
          seller: { select: { id: true, name: true, email: true } },
          currentAgreementVersion: {
            include: {
              createdBy: { select: { id: true, name: true, email: true } },
              signatures: {
                include: {
                  signer: { select: { id: true, name: true, email: true } },
                },
                orderBy: [{ signedAt: "asc" }, { id: "asc" }],
              },
            },
          },
          messages: {
            include: {
              sender: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
          ledgerEntries: {
            include: {
              actor: { select: { id: true, name: true, email: true } },
              milestone: { select: { id: true, title: true } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
          auditEvents: {
            include: {
              actor: { select: { id: true, name: true, email: true } },
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      },
    },
  });

  if (!dispute) throw new AppError("Dispute not found.", 404);
  if (!dispute.escrow) {
    throw new AppError("This arbitration does not have a linked escrow agreement.", 409);
  }
  const escrow = dispute.escrow;
  if (
    partyUserId
    && escrow.buyerId !== partyUserId
    && escrow.sellerId !== partyUserId
  ) {
    throw new AppError("Only the affected buyer or seller can access this arbitration report.", 403);
  }
  if (dispute.milestone && dispute.milestone.escrowId !== escrow.id) {
    throw new AppError("The disputed milestone is not linked to this arbitration escrow.", 409);
  }
  if (!dispute.arbitrationRequestedAt) {
    throw new AppError("An arbitration report is available only after arbitration is requested.", 409);
  }
  const agreement = escrow.currentAgreementVersion;
  if (!agreement) {
    throw new AppError("This arbitration does not have a linked escrow agreement.", 409);
  }

  const parties = [
    escrow.buyer
      ? {
          ...escrow.buyer,
          role: "buyer" as const,
          agreementIdentity: agreement.creatorRole === "buyer"
            ? agreement.creatorParty
            : agreement.counterpartyParty,
        }
      : null,
    escrow.seller
      ? {
          ...escrow.seller,
          role: "seller" as const,
          agreementIdentity: agreement.creatorRole === "seller"
            ? agreement.creatorParty
            : agreement.counterpartyParty,
        }
      : null,
  ].filter((party) => party !== null);

  const signatures = agreement.signatures.map((signature) => ({
    id: signature.id,
    signer: signature.signer,
    signerRole: signature.signerRole,
    signedAt: signature.signedAt.toISOString(),
    evidenceHash: signature.evidenceHash,
    signatureDataUrl: signature.signatureDataUrl,
  }));

  const milestoneExhibits = (dispute.milestone?.submissions ?? []).flatMap((submission) =>
    submission.evidence.filter((item) => item.storageStatus === "managed").map((item) => ({
      id: `milestone-${item.id}`,
      source: "milestone_submission" as const,
      sourceSubmissionId: submission.id,
      sourceSubmissionNumber: submission.submissionNumber,
      context: `Milestone submission ${submission.submissionNumber}: ${dispute.milestone?.title ?? "Disputed milestone"}`,
      submittedAt: submission.submittedAt.toISOString(),
      submittedBy: submission.submitter,
      objectKey: item.objectKey,
      fileName: item.fileName,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256.toLowerCase(),
      createdAt: item.createdAt.toISOString(),
    })));

  const disputeExhibits = dispute.evidenceSubmissions.flatMap((submission) =>
    submission.files.filter((item) => item.storageStatus === "managed").map((item) => ({
      id: `dispute-${item.id}`,
      source: "dispute_evidence" as const,
      sourceSubmissionId: submission.id,
      sourceSubmissionNumber: null,
      context: `Formal dispute evidence submission ${submission.id}`,
      submittedAt: submission.submittedAt.toISOString(),
      submittedBy: submission.submitter,
      objectKey: item.objectKey,
      fileName: item.fileName,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256.toLowerCase(),
      createdAt: item.createdAt.toISOString(),
    })));

  const managedExhibits = [...milestoneExhibits, ...disputeExhibits];
  const findManagedExhibit = (reference: EvidenceReference) =>
    managedExhibits.find((item) =>
      item.objectKey === reference.objectKey
      && item.fileName === reference.fileName
      && item.contentType === reference.contentType
      && item.sizeBytes === reference.sizeBytes
      && item.sha256 === reference.sha256);

  const evidence = dispute.evidenceSubmissions.map((submission) => ({
    id: submission.id,
    note: submission.note,
    references: [
      ...submission.files.map((item) => ({
        exhibitId: item.storageStatus === "managed" ? `dispute-${item.id}` : null,
        fileName: item.fileName,
        contentType: item.contentType,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256.toLowerCase(),
        storageStatus: item.storageStatus === "managed"
          ? "managed" as const
          : "metadata_only" as const,
      })),
      ...evidenceReferences(submission.evidence).map((reference) => {
        const exhibit = findManagedExhibit(reference);
        return {
          exhibitId: exhibit?.id ?? null,
          fileName: reference.fileName,
          contentType: reference.contentType,
          sizeBytes: reference.sizeBytes,
          sha256: reference.sha256,
          storageStatus: exhibit ? "managed" as const : "metadata_only" as const,
        };
      }),
    ],
    submittedAt: submission.submittedAt.toISOString(),
    submitter: submission.submitter,
  }));

  const milestoneSubmissions = (dispute.milestone?.submissions ?? []).map((submission) => ({
    id: submission.id,
    submissionNumber: submission.submissionNumber,
    note: submission.note,
    submittedAt: submission.submittedAt.toISOString(),
    submitter: submission.submitter,
    evidence: submission.evidence.map((item) => ({
      id: item.id,
      exhibitId: item.storageStatus === "managed" ? `milestone-${item.id}` : null,
      fileName: item.fileName,
      contentType: item.contentType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256.toLowerCase(),
      storageStatus: item.storageStatus === "managed"
        ? "managed" as const
        : "metadata_only" as const,
      createdAt: item.createdAt.toISOString(),
    })),
    review: submission.review
      ? {
          decision: submission.review.decision,
          reason: submission.review.reason,
          reviewedAt: submission.review.reviewedAt.toISOString(),
          reviewer: submission.review.reviewer,
        }
      : null,
  }));

  const exhibits = managedExhibits.map((item) => ({
    id: item.id,
    source: item.source,
    sourceSubmissionId: item.sourceSubmissionId,
    sourceSubmissionNumber: item.sourceSubmissionNumber,
    context: item.context,
    submittedAt: item.submittedAt,
    submittedBy: item.submittedBy,
    fileName: item.fileName,
    contentType: item.contentType,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    createdAt: item.createdAt,
  }));

  const chatLog = escrow.messages.map((message) => ({
    id: message.id,
    body: message.body,
    sentAt: message.createdAt.toISOString(),
    sender: {
      ...message.sender,
      role: message.senderId === escrow.buyerId ? "buyer" as const : "seller" as const,
    },
  }));

  const financialLedger = escrow.ledgerEntries.map((entry) => ({
    id: entry.id,
    businessReference: entry.businessReference,
    movementType: entry.movementType,
    amountCents: entry.amountCents,
    currency: entry.currency,
    sourceCommand: entry.sourceCommand,
    createdAt: entry.createdAt.toISOString(),
    actor: entry.actor,
    milestone: entry.milestone,
  }));

  const timeline = [
    {
      at: escrow.createdAt.toISOString(),
      type: "escrow",
      action: "created",
      description: `Escrow ${escrow.reference} was created.`,
    },
    {
      at: agreement.createdAt.toISOString(),
      type: "agreement",
      action: "version_created",
      description: `Agreement version ${agreement.versionNumber} was created.`,
    },
    ...(agreement.lockedAt
      ? [{
          at: agreement.lockedAt.toISOString(),
          type: "agreement",
          action: "locked",
          description: `Agreement version ${agreement.versionNumber} was locked.`,
        }]
      : []),
    ...signatures.map((signature) => ({
      at: signature.signedAt,
      type: "agreement_signature",
      action: "signed",
      description: `${signature.signer.name} signed as ${signature.signerRole}.`,
    })),
    ...(escrow.fundedAt
      ? [{
          at: escrow.fundedAt.toISOString(),
          type: "escrow",
          action: "funded",
          description: "Escrow funding was recorded.",
        }]
      : []),
    ...milestoneSubmissions.flatMap((submission) => [
      {
        at: submission.submittedAt,
        type: "milestone_submission",
        action: "submitted",
        description: `${submission.submitter.name} submitted milestone work.`,
      },
      ...(submission.review
        ? [{
            at: submission.review.reviewedAt,
            type: "milestone_review",
            action: submission.review.decision,
            description: `${submission.review.reviewer.name} recorded a ${submission.review.decision} review.`,
          }]
        : []),
    ]),
    {
      at: dispute.createdAt.toISOString(),
      type: "dispute",
      action: "opened",
      description: `${dispute.openedBy?.name ?? "An escrow party"} opened ${dispute.reference}.`,
    },
    ...evidence.map((submission) => ({
      at: submission.submittedAt,
      type: "dispute_evidence",
      action: "submitted",
      description: `${submission.submitter.name} submitted dispute evidence.`,
    })),
    {
      at: dispute.arbitrationRequestedAt.toISOString(),
      type: "arbitration",
      action: "requested",
      description: `${dispute.arbitrationRequestedBy?.name ?? "An escrow party"} requested arbitration.`,
    },
    ...financialLedger.map((entry) => ({
      at: entry.createdAt,
      type: "ledger",
      action: entry.movementType,
      description: `${entry.movementType.replaceAll("_", " ")}: ${entry.amountCents} ${entry.currency} cents.`,
    })),
    ...escrow.auditEvents.map((event) => ({
      at: event.createdAt.toISOString(),
      type: "audit",
      action: event.action,
      description: `${event.action.replaceAll(".", " ")} (${event.outcome}).`,
    })),
  ].sort((left, right) =>
    left.at.localeCompare(right.at)
    || left.type.localeCompare(right.type)
    || left.action.localeCompare(right.action));

  const reportCore = {
    reportVersion: 2,
    reportId: `MYE-ARB-${dispute.reference}`,
    case: {
      reference: dispute.reference,
      title: dispute.title,
      status: dispute.status,
      priority: dispute.priority,
      reason: dispute.reason,
      amountFrozenCents: dispute.amountFrozenCents,
      currency: agreement.currency,
      openedAt: dispute.createdAt.toISOString(),
      evidenceWindowEndsAt: dispute.evidenceWindowEndsAt?.toISOString() ?? null,
      arbitrationRequestedAt: dispute.arbitrationRequestedAt.toISOString(),
      resolvedAt: dispute.resolvedAt?.toISOString() ?? null,
      openedBy: dispute.openedBy,
      arbitrationRequestedBy: dispute.arbitrationRequestedBy,
      requestedRelief: `A determination allocating the disputed ${(
        dispute.amountFrozenCents / 100
      ).toFixed(2)} ${agreement.currency} between the buyer and seller.`,
    },
    escrow: {
      reference: escrow.reference,
      title: escrow.title,
      description: escrow.description,
      lifecycleStatus: escrow.lifecycleStatus,
      fundingStatus: escrow.fundingStatus,
      fundingMode: escrow.fundingMode,
      amountCents: escrow.amountCents,
      createdAt: escrow.createdAt.toISOString(),
      fundedAt: escrow.fundedAt?.toISOString() ?? null,
    },
    parties,
    agreement: {
      id: agreement.id,
      versionNumber: agreement.versionNumber,
      status: agreement.status,
      termsHash: agreement.termsHash,
      title: agreement.title,
      description: agreement.description,
      amountCents: agreement.amountCents,
      currency: agreement.currency,
      creatorRole: agreement.creatorRole,
      creatorParty: agreement.creatorParty,
      counterpartyParty: agreement.counterpartyParty,
      milestones: Array.isArray(agreement.milestones) ? agreement.milestones : [],
      createdAt: agreement.createdAt.toISOString(),
      lockedAt: agreement.lockedAt?.toISOString() ?? null,
      createdBy: agreement.createdBy,
      signatures,
    },
    disputedMilestone: dispute.milestone
      ? {
          id: dispute.milestone.id,
          title: dispute.milestone.title,
          description: dispute.milestone.description,
          amountCents: dispute.milestone.amountCents,
          deadline: dispute.milestone.deadline?.toISOString() ?? null,
          status: dispute.milestone.status,
          submissions: milestoneSubmissions,
        }
      : null,
    evidence,
    exhibits,
    chatLog,
    financialLedger,
    timeline,
    limitations: [
      "This is a system-generated factual record, not a legal pleading or legal conclusion.",
      "The requested relief is a system summary; the arbitration request does not yet capture a separate party-authored claim and remedy.",
      "The agreement schema does not separately identify an arbitration provider, rules, seat, or arbitration clause.",
      "The downloadable PDF embeds every managed exhibit as an original-file attachment with a visible metadata cover; untrusted exhibit content is not parsed or imported into report pages.",
      "Managed exhibit attachments are not malware-scanned and must be treated as untrusted when extracted or opened.",
      "Legacy metadata-only evidence references cannot be embedded unless they match a managed file belonging to this arbitration; they remain identified in the manifest.",
      "The integrity SHA-256 identifies the report data returned by MyEscrow, excluding the generation time.",
      "The final downloadable PDF is not digitally signed; the displayed report hash is not a signature of the final PDF bytes.",
    ],
  };

  return {
    ...reportCore,
    generatedAt: new Date().toISOString(),
    integritySha256: sha256(reportCore),
  };
}

export async function openArbitrationExhibit(
  prisma: PrismaClient,
  reference: string,
  exhibitId: string,
  actor: { id: string; operatorRole: string | null },
) {
  const dispute = await prisma.dispute.findUnique({
    where: { reference },
    select: {
      id: true,
      milestoneId: true,
      arbitrationRequestedAt: true,
      escrow: {
        select: {
          id: true,
          buyerId: true,
          sellerId: true,
        },
      },
    },
  });
  if (!dispute) throw new AppError("Dispute not found.", 404);
  if (!dispute.escrow) {
    throw new AppError("This arbitration does not have a linked escrow agreement.", 409);
  }
  const isOperator = actor.operatorRole === "support" || actor.operatorRole === "admin";
  const isAffectedParty =
    dispute.escrow.buyerId === actor.id
    || dispute.escrow.sellerId === actor.id;
  if (!isOperator && !isAffectedParty) {
    throw new AppError("Only the affected parties or an authorized operator can access arbitration exhibits.", 403);
  }
  if (!dispute.arbitrationRequestedAt) {
    throw new AppError("Arbitration exhibits are available only after arbitration is requested.", 409);
  }

  const match = /^(milestone|dispute)-([1-9]\d*)$/.exec(exhibitId);
  if (!match) throw new AppError("Arbitration exhibit not found.", 404);
  const evidenceId = Number(match[2]);
  if (!Number.isSafeInteger(evidenceId) || evidenceId > 2_147_483_647) {
    throw new AppError("Arbitration exhibit not found.", 404);
  }
  const evidence = match[1] === "milestone"
    ? dispute.milestoneId
      ? await prisma.milestoneEvidenceReference.findFirst({
          where: {
            id: evidenceId,
            storageStatus: "managed",
            submission: {
              milestone: {
                id: dispute.milestoneId,
                escrowId: dispute.escrow.id,
              },
            },
          },
        })
      : null
    : await prisma.disputeEvidenceReference.findFirst({
        where: {
          id: evidenceId,
          storageStatus: "managed",
          submission: { disputeId: dispute.id },
        },
      });
  if (!evidence) throw new AppError("Arbitration exhibit not found.", 404);
  const [milestoneKeyCount, disputeKeyCount] = await Promise.all([
    prisma.milestoneEvidenceReference.count({
      where: { objectKey: evidence.objectKey, storageStatus: "managed" },
    }),
    prisma.disputeEvidenceReference.count({
      where: { objectKey: evidence.objectKey, storageStatus: "managed" },
    }),
  ]);
  if (milestoneKeyCount + disputeKeyCount !== 1) {
    throw new AppError("Evidence storage ownership could not be verified.", 409);
  }

  return {
    evidence,
    bytes: await readVerifiedEvidenceFile(evidence),
  };
}
