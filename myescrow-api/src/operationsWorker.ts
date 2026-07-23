import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runOperationalRecovery } from "./services/operationsService";

const prisma = new PrismaClient();
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
} as any;
const runOnce = process.argv.includes("--once");
const configuredInterval = Number(process.env.OPERATIONS_INTERVAL_MS ?? 60_000);
const intervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 10_000
  ? configuredInterval
  : 60_000;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  do {
    try {
      const result = await runOperationalRecovery(prisma, logger, new Date(), 100);
      logger.info(JSON.stringify({ event: "operational_recovery_completed", ...result }));
    } catch (error) {
      logger.error(error);
      if (runOnce) process.exitCode = 1;
    }
    if (!runOnce && !stopping) await wait(intervalMs);
  } while (!runOnce && !stopping);
}

void main().finally(async () => {
  await prisma.$disconnect();
});
