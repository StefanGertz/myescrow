import type { PrismaClient } from "@prisma/client";
import { readVerifiedEvidenceFile } from "./milestoneProofService";

type LegacyEvidence = {
  id: number;
  objectKey: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
};

type Candidate = LegacyEvidence & {
  kind: "milestone" | "dispute";
};

export type EvidenceProvenanceReport = {
  mode: "dry-run" | "apply";
  examined: number;
  eligible: number;
  promoted: number;
  candidates: Array<{
    kind: Candidate["kind"];
    id: number;
    fileName: string;
    sizeBytes: number;
    sha256: string;
  }>;
  skipped: Array<{
    kind: Candidate["kind"];
    id: number;
    fileName: string;
    reason: string;
  }>;
};

async function objectKeyUseCount(prisma: PrismaClient, objectKey: string) {
  const [milestoneCount, disputeCount] = await Promise.all([
    prisma.milestoneEvidenceReference.count({ where: { objectKey } }),
    prisma.disputeEvidenceReference.count({ where: { objectKey } }),
  ]);
  return milestoneCount + disputeCount;
}

export async function reconcileEvidenceProvenance(
  prisma: PrismaClient,
  options: { apply: boolean },
): Promise<EvidenceProvenanceReport> {
  const [milestoneRows, disputeRows] = await Promise.all([
    prisma.milestoneEvidenceReference.findMany({
      where: { storageStatus: "legacy_metadata" },
      select: {
        id: true,
        objectKey: true,
        fileName: true,
        sizeBytes: true,
        sha256: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.disputeEvidenceReference.findMany({
      where: { storageStatus: "legacy_metadata" },
      select: {
        id: true,
        objectKey: true,
        fileName: true,
        sizeBytes: true,
        sha256: true,
      },
      orderBy: { id: "asc" },
    }),
  ]);
  const rows: Candidate[] = [
    ...milestoneRows.map((row) => ({ ...row, kind: "milestone" as const })),
    ...disputeRows.map((row) => ({ ...row, kind: "dispute" as const })),
  ];
  const report: EvidenceProvenanceReport = {
    mode: options.apply ? "apply" : "dry-run",
    examined: rows.length,
    eligible: 0,
    promoted: 0,
    candidates: [],
    skipped: [],
  };

  for (const row of rows) {
    const useCount = await objectKeyUseCount(prisma, row.objectKey);
    if (useCount !== 1) {
      report.skipped.push({
        kind: row.kind,
        id: row.id,
        fileName: row.fileName,
        reason: `storage key is referenced ${useCount} times`,
      });
      continue;
    }
    try {
      await readVerifiedEvidenceFile(row);
    } catch (error) {
      report.skipped.push({
        kind: row.kind,
        id: row.id,
        fileName: row.fileName,
        reason: error instanceof Error ? error.message : "file verification failed",
      });
      continue;
    }

    report.eligible += 1;
    report.candidates.push({
      kind: row.kind,
      id: row.id,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
    });
    if (!options.apply) continue;
    const result = row.kind === "milestone"
      ? await prisma.milestoneEvidenceReference.updateMany({
          where: { id: row.id, storageStatus: "legacy_metadata" },
          data: { storageStatus: "managed" },
        })
      : await prisma.disputeEvidenceReference.updateMany({
          where: { id: row.id, storageStatus: "legacy_metadata" },
          data: { storageStatus: "managed" },
        });
    report.promoted += result.count;
  }

  return report;
}
