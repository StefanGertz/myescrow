import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PrismaClient } from "@prisma/client";
import type { FastifyRequest } from "fastify";
import { AppError } from "../utils/errors";
import type { MilestoneEvidenceInput, MilestoneSubmissionInput } from "./milestoneReviewService";

export const MAX_MILESTONE_PROOF_FILES = 10;
export const MAX_MILESTONE_PROOF_SIZE_BYTES = 25_000_000;
const MAX_MILESTONE_PROOF_TOTAL_BYTES = 100_000_000;
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

const storageRoot = () =>
  path.resolve(process.env.MILESTONE_PROOF_STORAGE_DIR ?? path.join(process.cwd(), "data", "milestone-proofs"));

export async function authorizeMilestoneProofUpload(
  prisma: PrismaClient,
  userId: string,
  reference: string,
) {
  const escrow = await prisma.escrow.findFirst({
    where: {
      reference,
      OR: [{ ownerId: userId }, { buyerId: userId }, { sellerId: userId }],
    },
    select: { sellerId: true },
  });
  if (!escrow) throw new AppError("Escrow not found.", 404);
  if (escrow.sellerId !== userId) {
    throw new AppError("Only the seller can upload milestone proof.", 403);
  }
}

function safeFileName(value: string) {
  const normalized = path.basename(value).replaceAll("\0", "").trim();
  if (!normalized) return "proof";
  return normalized.slice(0, 255);
}

function resolveObjectPath(objectKey: string) {
  const objectId = objectKey.startsWith(OBJECT_KEY_PREFIX)
    ? objectKey.slice(OBJECT_KEY_PREFIX.length)
    : "";
  if (!/^[0-9a-f-]{36}$/i.test(objectId)) {
    throw new AppError("Proof file is unavailable.", 404);
  }
  return path.join(storageRoot(), objectId);
}

export async function parseMilestoneProofSubmission(
  request: FastifyRequest,
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
          throw new AppError("Only a submission note and proof files are accepted.", 400);
        }
        if (part.valueTruncated || part.value.length > 5_000) {
          throw new AppError("Submission notes may contain no more than 5,000 characters.", 400);
        }
        note = part.value;
        continue;
      }

      if (part.fieldname !== "proofs") {
        part.file.resume();
        throw new AppError("Proof files must use the proofs field.", 400);
      }
      if (!acceptedContentTypes.has(part.mimetype.toLowerCase())) {
        part.file.resume();
        throw new AppError(
          "Unsupported proof file. Upload an image, PDF, text, Word, or spreadsheet document.",
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
          if (totalBytes > MAX_MILESTONE_PROOF_TOTAL_BYTES) {
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
        fileName: safeFileName(part.filename),
        contentType: part.mimetype.toLowerCase(),
        sizeBytes,
        sha256: hash.digest("hex"),
      });
    }
  } catch (error) {
    await removeProofObjectKeys(storedObjectKeys);
    if (error instanceof AppError) throw error;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 413) {
      throw new AppError("Upload up to 10 proof files, no more than 25 MB each.", 413);
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

export async function removeMilestoneProofs(evidence: MilestoneEvidenceInput[]) {
  await removeProofObjectKeys(evidence.map((item) => item.objectKey));
}

async function removeProofObjectKeys(objectKeys: string[]) {
  await Promise.all(objectKeys.map(async (objectKey) => {
    try {
      await rm(resolveObjectPath(objectKey), { force: true });
    } catch {
      // Cleanup is best-effort; invalid external object keys are never resolved.
    }
  }));
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
