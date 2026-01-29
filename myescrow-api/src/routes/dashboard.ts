import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { addTimelineEvent, createEscrow, getOverview, listDisputes, listEscrows, listNotifications, listWalletTransactions, recordWalletTransaction, updateDispute, updateEscrowState } from "../services/dashboardService";
import { adjustWalletBalance, findUserById } from "../services/userService";
import { AppError } from "../utils/errors";
import { dollarsToCents } from "../utils/currency";
import { nowIso } from "../utils/dates";

const createEscrowSchema = z.object({
  title: z.string().min(2),
  counterpart: z.string().min(2),
  amount: z.number().positive(),
  category: z.string().optional(),
  description: z.string().optional(),
});

const walletSchema = z.object({
  amount: z.number().positive(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.register(async (secured) => {
    secured.addHook("preHandler", secured.authenticate);

    const requireUser = async (request: FastifyRequest) => {
      const userId = request.user?.userId;
      if (!userId) {
        throw new AppError("User not found.", 401);
      }
      const user = await findUserById(secured.prisma, userId);
      if (!user) {
        throw new AppError("User not found.", 401);
      }
      return user;
    };

    secured.get("/api/dashboard/overview", async (request) => {
      const user = await requireUser(request);
      return getOverview(secured.prisma, user.id);
    });

    secured.get("/api/dashboard/escrows", async (request) => {
      const user = await requireUser(request);
      const escrows = await listEscrows(secured.prisma, user.id);
      return { escrows };
    });

    secured.post("/api/dashboard/escrows/create", async (request, reply) => {
      const user = await requireUser(request);
      const body = createEscrowSchema.parse(request.body);
      const escrow = await createEscrow(secured.prisma, user.id, body);
      reply.code(201);
      return {
        success: true,
        escrowId: escrow.id,
        reference: escrow.reference,
        createdAt: escrow.createdAt,
      };
    });

    const escrowAction = (path: string, handler: (reference: string, userId: string) => Promise<any>) => {
      secured.post(`/api/dashboard/escrows/:id/${path}`, async (request) => {
        const user = await requireUser(request);
        const { id } = idParamsSchema.parse(request.params);
        return handler(id, user.id);
      });
    };

    escrowAction("release", async (reference, userId) => {
      const escrow = await updateEscrowState(secured.prisma, userId, reference, {
        counterpartyApproved: true,
        status: "success",
        dueDescription: "Release queued",
      });
      await addTimelineEvent(secured.prisma, userId, {
        title: `Release approved for ${escrow.reference}`,
        meta: `${escrow.counterpart} milestone queued`,
        status: "released",
      });
      return {
        success: true,
        escrowId: escrow.reference,
        releasedAt: nowIso(),
      };
    });

    escrowAction("approve", async (reference, userId) => {
      const escrow = await updateEscrowState(secured.prisma, userId, reference, {
        counterpartyApproved: true,
        status: "success",
        dueDescription: "Ready for release",
      });
      return { success: true, escrowId: escrow.reference };
    });

    escrowAction("reject", async (reference, userId) => {
      const escrow = await updateEscrowState(secured.prisma, userId, reference, {
        counterpartyApproved: false,
        status: "warning",
        dueDescription: "Awaiting revisions",
      });
      return { success: true, escrowId: escrow.reference };
    });

    escrowAction("cancel", async (reference, userId) => {
      const escrow = await updateEscrowState(secured.prisma, userId, reference, {
        status: "warning",
        stage: "Cancelled",
        dueDescription: "Cancelled",
      });
      return { success: true, escrowId: escrow.reference };
    });

    secured.get("/api/dashboard/disputes", async (request) => {
      const user = await requireUser(request);
      const disputes = await listDisputes(secured.prisma, user.id);
      return { disputes };
    });

    secured.post("/api/dashboard/disputes/:id/launch", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      await updateDispute(secured.prisma, user.id, id, {
        workspaceLaunched: true,
        updatedLabel: "Workspace launched just now",
      });
      return { disputeId: id, launchedAt: nowIso() };
    });

    secured.post("/api/dashboard/disputes/:id/resolve", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      await updateDispute(secured.prisma, user.id, id, {
        status: "resolved",
        updatedLabel: "Resolved",
      });
      return { disputeId: id, resolvedAt: nowIso() };
    });

    secured.get("/api/dashboard/notifications", async (request) => {
      const user = await requireUser(request);
      const notifications = await listNotifications(secured.prisma, user.id);
      return { notifications };
    });

    secured.post("/api/dashboard/wallet/topup", async (request) => {
      const user = await requireUser(request);
      const { amount } = walletSchema.parse(request.body);
      const cents = dollarsToCents(amount);
      const updatedUser = await adjustWalletBalance(secured.prisma, user.id, cents);
      await recordWalletTransaction(secured.prisma, user.id, cents, "TOPUP");
      return {
        success: true,
        amount,
        balance: Number((updatedUser.walletBalanceCents / 100).toFixed(2)),
      };
    });

    secured.post("/api/dashboard/wallet/withdraw", async (request) => {
      const user = await requireUser(request);
      const { amount } = walletSchema.parse(request.body);
      const cents = dollarsToCents(amount);
      const updatedUser = await adjustWalletBalance(secured.prisma, user.id, -cents);
      await recordWalletTransaction(secured.prisma, user.id, cents, "WITHDRAW");
      return {
        success: true,
        amount,
        balance: Number((updatedUser.walletBalanceCents / 100).toFixed(2)),
      };
    });

    secured.get("/api/dashboard/wallet/transactions", async (request) => {
      const user = await requireUser(request);
      const transactions = await listWalletTransactions(secured.prisma, user.id);
      return { transactions };
    });
  });
}
