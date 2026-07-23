import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runOperationalRecovery } from "../src/services/operationsService";

const prisma = new PrismaClient();
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
} as any;

async function main() {
  try {
    const result = await runOperationalRecovery(prisma, logger, new Date(), 100);
    console.log(JSON.stringify(result));
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
