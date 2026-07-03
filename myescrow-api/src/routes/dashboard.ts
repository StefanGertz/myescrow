import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  addTimelineEvent,
  approveEscrow,
  approveMilestone,
  cancelEscrow,
  createEscrow,
  dismissNotification,
  fundEscrow,
  getOverview,
  listDisputes,
  listEscrows,
  listNotifications,
  listWalletTransactions,
  recordWalletTransaction,
  rejectEscrow,
  rejectMilestone,
  releaseEscrow,
  resubmitMilestone,
  updateDispute,
} from "../services/dashboardService";
import { sendEscrowInvitationEmail } from "../services/emailService";
import { adjustWalletBalance, findUserById } from "../services/userService";
import { AppError } from "../utils/errors";
import { dollarsToCents } from "../utils/currency";
import { nowIso } from "../utils/dates";

const signatureDataUrlSchema = z
  .string()
  .max(500_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Signature must be a PNG data URL.");

const createEscrowSchema = z.object({
  title: z.string().min(2),
  counterpart: z.string().min(2),
  counterpartyEmail: z.string().email(),
  amount: z.number().positive(),
  creatorRole: z.enum(["buyer", "seller"]).default("buyer"),
  category: z.string().optional(),
  description: z.string().optional(),
  signatureDataUrl: signatureDataUrlSchema.optional(),
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      amount: z.number().positive(),
      description: z.string().optional(),
    }),
  ).optional(),
});

const walletSchema = z.object({
  amount: z.number().positive(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });
const milestoneParamsSchema = z.object({
  id: z.string().min(1),
  milestoneId: z.coerce.number().int().positive(),
});

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
      const result = await createEscrow(secured.prisma, user.id, {
        title: body.title,
        counterpart: body.counterpart,
        counterpartyEmail: body.counterpartyEmail,
        amount: body.amount,
        creatorRole: body.creatorRole,
        ...(body.category ? { category: body.category } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.signatureDataUrl ? { signatureDataUrl: body.signatureDataUrl } : {}),
        ...(body.milestones ? { milestones: body.milestones } : {}),
      });
      await sendEscrowInvitationEmail({
        to: result.invitedEmail,
        recipientName: result.counterpartyUser?.name ?? body.counterpart,
        creatorName: result.owner.name,
        escrowTitle: result.escrow.title,
        escrowReference: result.escrow.reference,
        creatorRole: body.creatorRole,
        invitationStatus: result.invitationStatus,
        logger: secured.log,
      });
      reply.code(201);
      return {
        success: true,
        escrowId: result.escrow.id,
        reference: result.escrow.reference,
        invitationStatus: result.invitationStatus,
        createdAt: result.escrow.createdAt,
      };
    });

    secured.post("/api/dashboard/escrows/:id/release", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const escrow = await releaseEscrow(secured.prisma, user.id, id);
      await addTimelineEvent(secured.prisma, user.id, {
        title: `Release approved for ${escrow.reference}`,
        meta: `${escrow.counterpart} payout sent`,
        status: "released",
      });
      return {
        success: true,
        escrowId: escrow.reference,
        releasedAt: nowIso(),
      };
    });

    secured.post("/api/dashboard/escrows/:id/approve", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = z.object({ signatureDataUrl: signatureDataUrlSchema.optional() }).parse(request.body ?? {});
      const escrow = await approveEscrow(secured.prisma, user.id, id, body.signatureDataUrl);
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/reject", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const escrow = await rejectEscrow(secured.prisma, user.id, id);
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/cancel", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const escrow = await cancelEscrow(secured.prisma, user.id, id);
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/fund", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const escrow = await fundEscrow(secured.prisma, user.id, id);
      return {
        success: true,
        escrowId: escrow.reference,
        fundedAt: escrow.fundedAt?.toISOString() ?? nowIso(),
      };
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/approve", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const result = await approveMilestone(secured.prisma, user.id, id, milestoneId);
      return {
        success: true,
        escrowId: result.escrow.reference,
        milestoneId: result.milestone.id,
        releasedAt: result.milestone.releasedAt?.toISOString() ?? nowIso(),
      };
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/reject", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const result = await rejectMilestone(secured.prisma, user.id, id, milestoneId);
      return {
        success: true,
        escrowId: result.escrow.reference,
        milestoneId: result.milestone.id,
        rejectedAt: result.milestone.rejectedAt?.toISOString() ?? nowIso(),
      };
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/resubmit", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const result = await resubmitMilestone(secured.prisma, user.id, id, milestoneId);
      return {
        success: true,
        escrowId: result.escrow.reference,
        milestoneId: result.milestone.id,
      };
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

    secured.post("/api/dashboard/notifications/:id/dismiss", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      await dismissNotification(secured.prisma, user.id, id);
      return { success: true };
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
