import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { reconcileEvidenceProvenance } from "../src/services/evidenceProvenanceService";

const prisma = new PrismaClient();
const apply = process.argv.includes("--apply");

async function main() {
  const report = await reconcileEvidenceProvenance(prisma, { apply });

  console.log(JSON.stringify(report, null, 2));
  if (!apply && report.eligible > 0) {
    console.log(
      "Dry run only. Review the candidates, then rerun with --apply to promote verified files.",
    );
  }
}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
