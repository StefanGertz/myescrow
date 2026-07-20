import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { processInvitationOutbox } from "../src/services/invitationService";

const prisma = new PrismaClient();
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
} as any;

async function main() {
  try {
    const result = await processInvitationOutbox(prisma, logger, 100);
    console.log(JSON.stringify(result));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
