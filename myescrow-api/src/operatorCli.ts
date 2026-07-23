import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { bootstrapFirstAdmin } from "./services/operatorService";

const prisma = new PrismaClient();

async function main() {
  const [command, email] = process.argv.slice(2);
  if (command !== "bootstrap" || !email) {
    throw new Error("Usage: npm run operators:bootstrap -- admin@example.com");
  }
  const result = await bootstrapFirstAdmin(prisma, email);
  console.log(JSON.stringify(result));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
