import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { reconcileEscrowLedger } from "../src/services/moneyIntegrityService";

const prisma = new PrismaClient();

async function main() {
  try {
    const report = await reconcileEscrowLedger(prisma);
    console.log(JSON.stringify(report, null, 2));
    if (report.exceptions.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
