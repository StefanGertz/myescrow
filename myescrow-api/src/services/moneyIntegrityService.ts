import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";
import { executeIdempotentCommand } from "./idempotencyService";

export type LedgerBalances = {
  currency: "USD";
  fundedCents: number;
  heldCents: number;
  releasedCents: number;
  refundedCents: number;
  disputedCents: number;
};

type LedgerLike = { movementType: string; amountCents: number };

export function deriveLedgerBalances(entries: LedgerLike[], disputedCents = 0): LedgerBalances {
  const fundedCents = entries
    .filter((entry) => entry.movementType === "fund")
    .reduce((total, entry) => total + entry.amountCents, 0);
  const releasedCents = entries
    .filter((entry) => entry.movementType === "release" || entry.movementType === "settlement_release")
    .reduce((total, entry) => total + Math.abs(entry.amountCents), 0);
  const refundedCents = entries
    .filter((entry) => entry.movementType === "refund" || entry.movementType === "settlement_refund")
    .reduce((total, entry) => total + Math.abs(entry.amountCents), 0);
  return {
    currency: "USD",
    fundedCents,
    heldCents: fundedCents - releasedCents - refundedCents,
    releasedCents,
    refundedCents,
    disputedCents,
  };
}

export async function getEscrowLedgerBalances(
  prisma: Pick<PrismaClient, "escrowLedgerEntry" | "dispute"> | Prisma.TransactionClient,
  escrowId: number,
) {
  const [entries, activeDisputes] = await Promise.all([
    prisma.escrowLedgerEntry.findMany({
      where: { escrowId },
      select: { movementType: true, amountCents: true },
    }),
    prisma.dispute.findMany({
      where: {
        escrowId,
        status: { in: ["open", "resolution_proposed", "resolving"] },
      },
      select: { amountFrozenCents: true },
    }),
  ]);
  const disputedCents = activeDisputes.reduce(
    (total, dispute) => total + dispute.amountFrozenCents,
    0,
  );
  return deriveLedgerBalances(entries, disputedCents);
}

export async function applyWalletTransfer(
  tx: Prisma.TransactionClient,
  input: { userId: string; amountCents: number; type: string },
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents === 0) {
    throw new AppError("Wallet transfer amount must be a non-zero number of cents.", 400);
  }
  const updated = await tx.user.updateMany({
    where: {
      id: input.userId,
      ...(input.amountCents < 0
        ? { walletBalanceCents: { gte: Math.abs(input.amountCents) } }
        : {}),
    },
    data: { walletBalanceCents: { increment: input.amountCents } },
  });
  if (updated.count !== 1) {
    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
    if (!user) throw new AppError("User not found.", 404);
    throw new AppError("Insufficient wallet balance.", 400);
  }
  return tx.walletTransaction.create({
    data: {
      userId: input.userId,
      amountCents: input.amountCents,
      type: input.type,
    },
  });
}

export async function recordStandaloneWalletTransfer(
  prisma: PrismaClient,
  input: { userId: string; amountCents: number; type: "TOPUP" | "WITHDRAW" },
  idempotencyKey: string,
) {
  return executeIdempotentCommand(
    prisma,
    {
      userId: input.userId,
      key: idempotencyKey,
      command: input.type === "TOPUP" ? "wallet_topup" : "wallet_withdraw",
      payload: { amountCents: input.amountCents },
    },
    async (tx) => {
      await applyWalletTransfer(tx, input);
      const user = await tx.user.findUnique({ where: { id: input.userId } });
      if (!user) throw new AppError("User not found.", 404);
      return {
        success: true,
        amountCents: Math.abs(input.amountCents),
        balanceCents: user.walletBalanceCents,
      };
    },
  );
}

export async function applyEscrowTransfer(
  tx: Prisma.TransactionClient,
  input: {
    escrowId: number;
    milestoneId?: number;
    movementType: "fund" | "release" | "refund" | "settlement_release" | "settlement_refund";
    amountCents: number;
    currency?: "USD";
    idempotencyKey: string;
    businessReference: string;
    actorId: string;
    sourceCommand: string;
    walletUserId: string;
    paymentProviderRef?: string;
  },
) {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new AppError("Escrow transfer amount must be a positive number of cents.", 400);
  }

  const before = await getEscrowLedgerBalances(tx, input.escrowId);
  if (input.movementType === "fund" && before.fundedCents !== 0) {
    throw new AppError("This escrow already has a funding ledger entry.", 409);
  }
  const isSettlement = ["settlement_release", "settlement_refund"].includes(input.movementType);
  const availableCents = before.heldCents - before.disputedCents;
  if (
    input.movementType !== "fund"
    && (isSettlement ? before.heldCents : availableCents) < input.amountCents
  ) {
    throw new AppError("The escrow does not have enough held funds for this transfer.", 409);
  }

  const isWalletCredit = input.movementType !== "fund";
  const walletTransaction = await applyWalletTransfer(tx, {
    userId: input.walletUserId,
    amountCents: isWalletCredit ? input.amountCents : -input.amountCents,
    type: input.movementType === "fund" ? "FUND" : input.movementType.toUpperCase(),
  });
  const ledgerAmount = input.movementType === "fund" ? input.amountCents : -input.amountCents;
  const entry = await tx.escrowLedgerEntry.create({
    data: {
      escrowId: input.escrowId,
      ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
      movementType: input.movementType,
      amountCents: ledgerAmount,
      currency: input.currency ?? "USD",
      idempotencyKey: input.idempotencyKey,
      businessReference: input.businessReference,
      actorId: input.actorId,
      sourceCommand: input.sourceCommand,
      ...(input.paymentProviderRef ? { paymentProviderRef: input.paymentProviderRef } : {}),
      walletTransactionId: walletTransaction.id,
    },
  });
  const balances = await getEscrowLedgerBalances(tx, input.escrowId);
  if (
    balances.heldCents < 0
    || balances.releasedCents + balances.refundedCents > balances.fundedCents
  ) {
    throw new AppError("Escrow ledger invariant failed.", 409);
  }
  return { entry, walletTransaction, balances };
}

export type ReconciliationException = {
  escrowId: number;
  reference: string;
  issues: string[];
  balances: LedgerBalances;
};

export async function reconcileEscrowLedger(prisma: PrismaClient) {
  const escrows = await prisma.escrow.findMany({
    where: { OR: [{ fundingStatus: "funded" }, { ledgerEntries: { some: {} } }] },
    include: {
      milestones: true,
      ledgerEntries: { include: { walletTransaction: true } },
    },
    orderBy: { id: "asc" },
  });
  const exceptions: ReconciliationException[] = [];
  for (const escrow of escrows) {
    const balances = deriveLedgerBalances(escrow.ledgerEntries);
    const issues: string[] = [];
    const expectedFunded = balances.fundedCents > 0 ? escrow.amountCents : 0;
    const expectedReleased = escrow.milestones.reduce((total, milestone) => {
      if (milestone.status === "released") return total + milestone.amountCents;
      if (milestone.status !== "settled") return total;
      return total + escrow.ledgerEntries
        .filter((entry) =>
          entry.milestoneId === milestone.id
          && entry.movementType === "settlement_release")
        .reduce((sum, entry) => sum + Math.abs(entry.amountCents), 0);
    }, 0);
    if (balances.fundedCents !== expectedFunded) {
      issues.push(`funded ledger ${balances.fundedCents} != escrow ${expectedFunded}`);
    }
    if (balances.releasedCents !== expectedReleased) {
      issues.push(`released ledger ${balances.releasedCents} != milestones ${expectedReleased}`);
    }
    if (balances.heldCents < 0 || balances.releasedCents + balances.refundedCents > balances.fundedCents) {
      issues.push("core ledger invariant failed");
    }
    for (const entry of escrow.ledgerEntries) {
      if (entry.sourceCommand.endsWith("backfill")) continue;
      if (!entry.walletTransaction) {
        issues.push(`ledger entry ${entry.id} is missing a wallet transaction`);
        continue;
      }
      const expectedWalletAmount = entry.movementType === "fund"
        ? -Math.abs(entry.amountCents)
        : Math.abs(entry.amountCents);
      if (entry.walletTransaction.amountCents !== expectedWalletAmount) {
        issues.push(`ledger entry ${entry.id} does not match wallet transaction ${entry.walletTransaction.id}`);
      }
    }
    if (issues.length > 0) {
      exceptions.push({ escrowId: escrow.id, reference: escrow.reference, issues, balances });
    }
  }
  return { checkedEscrows: escrows.length, exceptions };
}
