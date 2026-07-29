import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { AppError } from "../utils/errors";
import {
  milestoneIsFullyFunded,
  totalFundedFromLedger,
} from "../utils/stagedFunding";
import type { MilestoneEvidenceInput, MilestoneSubmissionInput } from "./milestoneReviewService";

export const MAX_MILESTONE_PROOF_FILES = 10;
export const MAX_MILESTONE_PROOF_SIZE_BYTES = 25_000_000;
export const MAX_ARBITRATION_EVIDENCE_BYTES = 100_000_000;
export const MAX_ARBITRATION_EVIDENCE_FILES = 100;
const OBJECT_KEY_PREFIX = "milestone-proofs/";

const acceptedContentTypes = new Set([
  "application/msword",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
]);

const acceptedExtensionsByContentType: Record<string, ReadonlySet<string>> = {
  "application/msword": new Set([".doc"]),
  "application/pdf": new Set([".pdf"]),
  "application/rtf": new Set([".rtf"]),
  "application/vnd.ms-excel": new Set([".xls"]),
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": new Set([".xlsx"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": new Set([".docx"]),
  "image/heic": new Set([".heic"]),
  "image/heif": new Set([".heif"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/png": new Set([".png"]),
  "image/webp": new Set([".webp"]),
  "text/csv": new Set([".csv"]),
  "text/plain": new Set([".txt"]),
};

const storageRoot = () =>
  path.resolve(process.env.MILESTONE_PROOF_STORAGE_DIR ?? path.join(process.cwd(), "data", "milestone-proofs"));

export async function authorizeMilestoneProofUpload(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
) {
  const escrow = await prisma.escrow.findFirst({
    where: {
      reference,
      OR: [{ ownerId: userId }, { buyerId: userId }, { sellerId: userId }],
    },
    select: {
      id: true,
      sellerId: true,
      lifecycleStatus: true,
      fundingMode: true,
      milestones: {
        orderBy: { orderIndex: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          amountCents: true,
          orderIndex: true,
        },
      },
      ledgerEntries: {
        where: { movementType: "fund" },
        select: { movementType: true, amountCents: true },
      },
    },
  });
  if (!escrow) throw new AppError("Escrow not found.", 404);
  if (escrow.sellerId !== userId) {
    throw new AppError("Only the seller can upload milestone proof.", 403);
  }
  if (escrow.lifecycleStatus !== "funded") {
    throw new AppError("Milestone proof can only be uploaded after funding.", 400);
  }
  const milestone = escrow.milestones.find((item) => item.id === milestoneId);
  if (!milestone) throw new AppError("Milestone not found.", 404);
  if (
    escrow.fundingMode !== "full"
    && !milestoneIsFullyFunded(
      escrow.milestones,
      totalFundedFromLedger(escrow.ledgerEntries),
      milestone.id,
    )
  ) {
    throw new AppError(
      "The buyer must fully fund this milestone before proof can be uploaded.",
      409,
    );
  }
  const blockedBy = escrow.milestones.find(
    (item) =>
      item.orderIndex < milestone.orderIndex
      && !["released", "refunded", "settled", "cancelled"].includes(item.status),
  );
  if (blockedBy) {
    throw new AppError(
      `Complete the earlier milestone "${blockedBy.title}" before proof can be uploaded.`,
      409,
    );
  }
}

function safeFileName(value: string) {
  const normalized = path.basename(value).replaceAll("\0", "").trim();
  if (!normalized) return "proof";
  return Array.from(normalized).slice(0, 255).join("");
}

function resolveObjectPath(objectKey: string) {
  const objectId = objectKey.startsWith(OBJECT_KEY_PREFIX)
    ? objectKey.slice(OBJECT_KEY_PREFIX.length)
    : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(objectId)) {
    throw new AppError("Proof file is unavailable.", 404);
  }
  return path.join(storageRoot(), objectId);
}

async function parseStoredEvidenceSubmission(
  request: FastifyRequest,
  fileField: "proofs" | "evidence",
): Promise<{ input: MilestoneSubmissionInput; storedEvidence: MilestoneEvidenceInput[] }> {
  await mkdir(storageRoot(), { recursive: true });
  const evidence: MilestoneEvidenceInput[] = [];
  const storedObjectKeys: string[] = [];
  let note: string | undefined;
  let totalBytes = 0;

  try {
    const parts = request.parts({
      limits: {
        fields: 1,
        fieldSize: 5_000,
        files: MAX_MILESTONE_PROOF_FILES,
        fileSize: MAX_MILESTONE_PROOF_SIZE_BYTES,
        parts: MAX_MILESTONE_PROOF_FILES + 1,
      },
    });

    for await (const part of parts) {
      if (part.type === "field") {
        if (part.fieldname !== "note" || typeof part.value !== "string") {
          throw new AppError("Only a submission note and evidence files are accepted.", 400);
        }
        if (part.valueTruncated || part.value.length > 5_000) {
          throw new AppError("Submission notes may contain no more than 5,000 characters.", 400);
        }
        note = part.value;
        continue;
      }

      if (part.fieldname !== fileField) {
        part.file.resume();
        throw new AppError(`Evidence files must use the ${fileField} field.`, 400);
      }
      const contentType = part.mimetype.toLowerCase();
      const fileName = safeFileName(part.filename);
      const acceptedExtensions = acceptedExtensionsByContentType[contentType];
      if (
        !acceptedContentTypes.has(contentType)
        || !acceptedExtensions?.has(path.extname(fileName).toLowerCase())
      ) {
        part.file.resume();
        throw new AppError(
          "Unsupported evidence file or filename extension. Upload a matching image, PDF, text, Word, or spreadsheet document.",
          400,
        );
      }

      const objectId = randomUUID();
      const objectKey = `${OBJECT_KEY_PREFIX}${objectId}`;
      const destination = resolveObjectPath(objectKey);
      storedObjectKeys.push(objectKey);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          totalBytes += chunk.length;
          hash.update(chunk);
          if (totalBytes > MAX_ARBITRATION_EVIDENCE_BYTES) {
            callback(new AppError("Proof files may total no more than 100 MB.", 413));
            return;
          }
          callback(null, chunk);
        },
      });

      await pipeline(part.file, meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      if (part.file.truncated) {
        await rm(destination, { force: true });
        throw new AppError("Each proof file must be 25 MB or smaller.", 413);
      }
      if (sizeBytes === 0) {
        await rm(destination, { force: true });
        throw new AppError("Proof files cannot be empty.", 400);
      }

      evidence.push({
        objectKey,
        fileName,
        contentType,
        sizeBytes,
        sha256: hash.digest("hex"),
        storageStatus: "managed",
      });
    }
  } catch (error) {
    await removeProofObjectKeys(storedObjectKeys);
    if (error instanceof AppError) throw error;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      throw new AppError("Upload up to 10 evidence files, no more than 25 MB each.", 413);
    }
    throw error;
  }

  return {
    input: {
      ...(note !== undefined ? { note } : {}),
      ...(evidence.length ? { evidence } : {}),
    },
    storedEvidence: evidence,
  };
}

export async function parseMilestoneProofSubmission(request: FastifyRequest) {
  return parseStoredEvidenceSubmission(request, "proofs");
}

export async function parseDisputeEvidenceSubmission(request: FastifyRequest) {
  return parseStoredEvidenceSubmission(request, "evidence");
}

export async function removeMilestoneProofs(evidence: MilestoneEvidenceInput[]) {
  await removeProofObjectKeys(evidence.map((item) => item.objectKey));
}

export const removeStoredEvidenceFiles = removeMilestoneProofs;

async function removeProofObjectKeys(objectKeys: string[]) {
  await Promise.all(objectKeys.map(async (objectKey) => {
    try {
      await rm(resolveObjectPath(objectKey), { force: true });
    } catch {
      // Cleanup is best-effort; invalid external object keys are never resolved.
    }
  }));
}

export async function readVerifiedEvidenceFile(evidence: {
  objectKey: string;
  sizeBytes: number;
  sha256: string;
}) {
  let bytes: Buffer;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      resolveObjectPath(evidence.objectKey),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error("Not a regular file");
    bytes = await handle.readFile();
  } catch {
    throw new AppError("Evidence file is unavailable.", 404);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== evidence.sizeBytes
    || actualHash !== evidence.sha256.toLowerCase()
  ) {
    throw new AppError("Evidence file failed its stored size or SHA-256 integrity check.", 409);
  }
  return bytes;
}

export async function openMilestoneProof(
  prisma: PrismaClient,
  userId: string,
  reference: string,
  milestoneId: number,
  submissionId: number,
  evidenceId: number,
) {
  const evidence = await prisma.milestoneEvidenceReference.findFirst({
    where: {
      id: evidenceId,
      storageStatus: "managed",
      submissionId,
      submission: {
        milestoneId,
        milestone: {
          escrow: {
            reference,
            OR: [{ ownerId: userId }, { buyerId: userId }, { sellerId: userId }],
          },
        },
      },
    },
  });
  if (!evidence) throw new AppError("Proof file not found.", 404);

  const filePath = resolveObjectPath(evidence.objectKey);
  try {
    await access(filePath);
    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) throw new Error("Not a file");
  } catch {
    throw new AppError("Proof file is unavailable.", 404);
  }

  return {
    evidence,
    stream: createReadStream(filePath),
  };
}
