import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { processMilestoneReviewDeadlines } from "../src/services/milestoneReviewService";

const prisma = new PrismaClient();

async function main() {
  try {
    console.log(JSON.stringify(await processMilestoneReviewDeadlines(prisma)));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
