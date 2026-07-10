import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  addTimelineEvent,
  applyAgreementChanges,
  applyMilestoneChanges,
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
  requestAgreementChanges,
  requestMilestoneChanges,
  releaseEscrow,
  resubmitMilestone,
  updateDispute,
} from "../services/dashboardService";
import { sendEscrowInvitationEmail, sendMilestoneChangeRequestEmail } from "../services/emailService";
import { adjustWalletBalance, findUserById } from "../services/userService";
import { AppError } from "../utils/errors";
import { dollarsToCents } from "../utils/currency";
import { nowIso } from "../utils/dates";

const signatureDataUrlSchema = z
  .string()
  .max(500_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Signature must be a PNG data URL.");

const partyIdentitySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("individual") }),
  z.object({
    type: z.literal("business"),
    business: z.object({
      legalName: z.string().trim().min(2),
      representativeTitle: z.string().trim().min(2),
      registrationCountry: z.string().trim().optional().default(""),
      registrationNumber: z.string().trim().optional().default(""),
      registeredAddress: z.string().trim().optional().default(""),
    }),
  }),
]);

const createEscrowSchema = z.object({
  title: z.string().min(2),
  counterpartyEmail: z.string().email(),
  amount: z.number().positive(),
  creatorRole: z.enum(["buyer", "seller"]).default("buyer"),
  creatorParty: partyIdentitySchema.default({ type: "individual" }),
  category: z.string().optional(),
  description: z.string().optional(),
  signatureDataUrl: signatureDataUrlSchema.optional(),
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      amount: z.number().positive(),
      description: z.string().optional(),
      deadline: z.string().datetime().optional(),
    }),
  ).optional(),
});

const walletSchema = z.object({
  amount: z.number().positive(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });
const notificationQuerySchema = z.object({ history: z.coerce.boolean().optional().default(false) });
const milestoneParamsSchema = z.object({
  id: z.string().min(1),
  milestoneId: z.coerce.number().int().positive(),
});
const milestoneChangeRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  amount: z.number().positive(),
  deadline: z.string().datetime().optional(),
  note: z.string().max(1000).optional(),
});

const milestoneChangeReviewSchema = z.object({
  decision: z.enum(["accept", "reject"]).default("accept"),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  amount: z.number().positive().optional(),
  deadline: z.string().datetime().nullable().optional(),
});

const agreementMilestoneChangeSchema = z.object({
  milestoneId: z.coerce.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  amount: z.number().positive(),
  deadline: z.string().datetime().optional(),
});

const agreementChangeRequestSchema = z.object({
  milestones: z.array(agreementMilestoneChangeSchema).min(1),
  note: z.string().max(1000).optional(),
});

const agreementChangeReviewSchema = z.object({
  decision: z.enum(["accept", "reject"]).default("accept"),
  milestones: z.array(agreementMilestoneChangeSchema).optional(),
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

    secured.get("/api/dashboard/business-profile", async (request) => {
      const user = await requireUser(request);
      const businessProfile = await secured.prisma.businessProfile.findUnique({ where: { userId: user.id } });
      return {
        businessProfile: businessProfile
          ? {
              legalName: businessProfile.legalName,
              representativeTitle: businessProfile.representativeTitle,
            }
          : null,
      };
    });

    secured.post("/api/dashboard/escrows/create", async (request, reply) => {
      const user = await requireUser(request);
      const body = createEscrowSchema.parse(request.body);
      const result = await createEscrow(secured.prisma, user.id, {
        title: body.title,
        counterpartyEmail: body.counterpartyEmail,
        amount: body.amount,
        creatorRole: body.creatorRole,
        creatorParty: body.creatorParty,
        ...(body.category ? { category: body.category } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.signatureDataUrl ? { signatureDataUrl: body.signatureDataUrl } : {}),
        ...(body.milestones ? { milestones: body.milestones } : {}),
      });
      await sendEscrowInvitationEmail({
        to: result.invitedEmail,
        recipientName: result.counterpartyUser?.name ?? result.invitedEmail,
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
        counterpart: result.escrow.counterpart,
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
      const body = z.object({
        signatureDataUrl: signatureDataUrlSchema.optional(),
        counterpartyParty: partyIdentitySchema.default({ type: "individual" }),
      }).parse(request.body ?? {});
      const escrow = await approveEscrow(secured.prisma, user.id, id, {
        ...(body.signatureDataUrl ? { signatureDataUrl: body.signatureDataUrl } : {}),
        counterpartyParty: body.counterpartyParty,
      });
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

    secured.post("/api/dashboard/escrows/:id/request-changes", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = agreementChangeRequestSchema.parse(request.body);
      const escrow = await requestAgreementChanges(secured.prisma, user.id, id, body);
      let emailNotification: "sent" | "skipped" | "failed" = "failed";
      try {
        emailNotification = await sendMilestoneChangeRequestEmail({
          to: escrow.owner.email,
          recipientName: escrow.owner.name,
          requesterName: user.name,
          escrowTitle: escrow.title,
          escrowReference: escrow.reference,
          milestoneTitle: "the agreement",
          ...(body.note ? { note: body.note } : {}),
          logger: request.log,
        });
      } catch (error) {
        request.log.error(
          { error, to: escrow.owner.email, escrowReference: escrow.reference },
          "Agreement change request was saved, but its email notification failed",
        );
      }
      return { success: true, escrowId: escrow.reference, emailNotification };
    });

    secured.post("/api/dashboard/escrows/:id/apply-changes", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = agreementChangeReviewSchema.parse(request.body ?? {});
      const escrow = await applyAgreementChanges(secured.prisma, user.id, id, body);
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/request-changes", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const body = milestoneChangeRequestSchema.parse(request.body);
      const escrow = await requestMilestoneChanges(secured.prisma, user.id, id, milestoneId, body);
      const milestone = escrow.milestones.find((item) => item.id === milestoneId);
      let emailNotification: "sent" | "skipped" | "failed" = "failed";
      try {
        emailNotification = await sendMilestoneChangeRequestEmail({
          to: escrow.owner.email,
          recipientName: escrow.owner.name,
          requesterName: user.name,
          escrowTitle: escrow.title,
          escrowReference: escrow.reference,
          milestoneTitle: milestone?.title ?? body.title,
          ...(body.note ? { note: body.note } : {}),
          logger: request.log,
        });
      } catch (error) {
        request.log.error(
          { error, to: escrow.owner.email, escrowReference: escrow.reference, milestoneId },
          "Milestone change request was saved, but its email notification failed",
        );
      }
      return { success: true, escrowId: escrow.reference, milestoneId, emailNotification };
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/apply-changes", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const body = milestoneChangeReviewSchema.parse(request.body ?? {});
      const escrow = await applyMilestoneChanges(secured.prisma, user.id, id, milestoneId, body);
      return { success: true, escrowId: escrow.reference, milestoneId };
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
      const { history } = notificationQuerySchema.parse(request.query);
      const notifications = await listNotifications(secured.prisma, user.id, history);
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
      await recordWalletTransaction(secured.prisma, user.id, -cents, "WITHDRAW");
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
