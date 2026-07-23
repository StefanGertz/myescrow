import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  applyAgreementChanges,
  applyMilestoneChanges,
  approveEscrow,
  approveMilestone,
  cancelEscrow,
  createEscrow,
  dismissNotification,
  extendEscrowInvitation,
  fundEscrow,
  getEscrowLedgerHistory,
  getOverview,
  listDisputes,
  listEscrows,
  listNotifications,
  listWalletTransactions,
  rejectEscrow,
  rejectMilestone,
  resendEscrowInvitation,
  requestAgreementChanges,
  requestMilestoneChanges,
  releaseEscrow,
  resubmitMilestone,
  signCurrentAgreement,
  updateDraftEscrow,
} from "../services/dashboardService";
import {
  acceptDisputeResolution,
  acceptFundedCancellation,
  openMilestoneDispute,
  proposeDisputeResolution,
  requestDisputeArbitration,
  requestFundedCancellation,
  submitDisputeEvidence,
} from "../services/disputeService";
import { sendMilestoneChangeRequestEmail } from "../services/emailService";
import { processInvitationOutbox } from "../services/invitationService";
import { findUserById } from "../services/userService";
import { recordStandaloneWalletTransfer } from "../services/moneyIntegrityService";
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
  signatureDataUrl: signatureDataUrlSchema,
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      amount: z.number().positive(),
      description: z.string().optional(),
      deadline: z.string().datetime().optional(),
    }),
  ).optional(),
});

const updateDraftEscrowSchema = z.object({
  title: z.string().min(2),
  counterpartyEmail: z.string().email(),
  amount: z.number().positive(),
  description: z.string().optional(),
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      amount: z.number().positive(),
      description: z.string().optional(),
      deadline: z.string().datetime().optional(),
    }),
  ).optional(),
});

const milestoneSubmissionSchema = z.object({
  note: z.string().trim().max(5_000).optional(),
  evidence: z.array(z.object({
    objectKey: z.string().trim().min(1).max(1_000),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z.number().int().positive().max(25_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  })).max(10).optional(),
});

const disputeEvidenceReferenceSchema = z.object({
  objectKey: z.string().trim().min(1).max(1_000),
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().positive().max(25_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

const disputeEvidenceSchema = z.object({
  note: z.string().trim().max(5_000).optional(),
  evidence: z.array(disputeEvidenceReferenceSchema).max(20).optional(),
});

const disputeResolutionSchema = z.object({
  sellerAmount: z.number().nonnegative(),
  buyerAmount: z.number().nonnegative(),
  note: z.string().trim().max(5_000).optional(),
});

const fundedCancellationSchema = z.object({
  mode: z.enum(["mutual", "unilateral"]),
  reason: z.string().trim().min(10).max(5_000),
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

    const requireIdempotencyKey = (request: FastifyRequest) => {
      const value = request.headers["idempotency-key"];
      if (typeof value !== "string" || value.trim().length < 8 || value.length > 200) {
        throw new AppError("A valid Idempotency-Key header is required for this command.", 400);
      }
      return value.trim();
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

    secured.get("/api/dashboard/escrows/:id/ledger", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return getEscrowLedgerHistory(secured.prisma, user.id, id);
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
        signatureDataUrl: body.signatureDataUrl,
        ...(body.category ? { category: body.category } : {}),
        ...(body.description ? { description: body.description } : {}),
        ...(body.milestones ? { milestones: body.milestones } : {}),
      }, requireIdempotencyKey(request));
      await processInvitationOutbox(secured.prisma, secured.log);
      reply.code(201);
      return {
        success: true,
        escrowId: result.escrowId,
        reference: result.reference,
        counterpart: result.counterpart,
        invitationStatus: result.invitationStatus,
        createdAt: result.createdAt,
      };
    });

    secured.patch("/api/dashboard/escrows/:id", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = updateDraftEscrowSchema.parse(request.body);
      const result = await updateDraftEscrow(secured.prisma, user.id, id, {
        title: body.title,
        counterpartyEmail: body.counterpartyEmail,
        amount: body.amount,
        ...(body.description ? { description: body.description } : {}),
        ...(body.milestones ? { milestones: body.milestones } : {}),
      });
      await processInvitationOutbox(secured.prisma, secured.log);
      return {
        success: true,
        escrowId: result.escrow.id,
        reference: result.escrow.reference,
        counterpart: result.escrow.counterpart,
        invitationStatus: result.invitationStatus,
        updatedAt: result.escrow.updatedAt,
      };
    });

    secured.post("/api/dashboard/escrows/:id/release", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      await releaseEscrow(secured.prisma, user.id, id);
      return { success: false };
    });

    secured.post("/api/dashboard/escrows/:id/approve", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = z.object({
        signatureDataUrl: signatureDataUrlSchema,
        counterpartyParty: partyIdentitySchema.default({ type: "individual" }),
      }).parse(request.body);
      const escrow = await approveEscrow(secured.prisma, user.id, id, {
        signatureDataUrl: body.signatureDataUrl,
        counterpartyParty: body.counterpartyParty,
      });
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/agreement/sign", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = z.object({ signatureDataUrl: signatureDataUrlSchema }).parse(request.body);
      const result = await signCurrentAgreement(
        secured.prisma,
        user.id,
        id,
        body.signatureDataUrl,
      );
      return {
        success: true,
        escrowId: result.escrow.reference,
        agreementVersion: result.escrow.currentAgreementVersion?.versionNumber,
        signedAt: result.signature.signedAt.toISOString(),
      };
    });

    secured.post("/api/dashboard/escrows/:id/reject", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const escrow = await rejectEscrow(secured.prisma, user.id, id);
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/invitation/resend", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const result = await resendEscrowInvitation(secured.prisma, user.id, id);
      await processInvitationOutbox(secured.prisma, secured.log);
      return {
        success: true,
        escrowId: result.escrow.reference,
        invitationStatus: result.delivery.status,
      };
    });

    secured.post("/api/dashboard/escrows/:id/invitation/extend", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const { days } = z.object({ days: z.number().int().min(1).max(30).default(7) }).parse(request.body ?? {});
      const delivery = await extendEscrowInvitation(secured.prisma, user.id, id, days);
      return { success: true, escrowId: id, expiresAt: delivery.expiresAt.toISOString() };
    });

    secured.post("/api/dashboard/escrows/:id/cancel", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const escrow = await cancelEscrow(secured.prisma, user.id, id);
      return { success: true, escrowId: escrow.reference };
    });

    secured.post("/api/dashboard/escrows/:id/cancellation/request", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = fundedCancellationSchema.parse(request.body);
      return requestFundedCancellation(
        secured.prisma,
        user.id,
        id,
        body,
        requireIdempotencyKey(request),
      );
    });

    secured.post("/api/dashboard/cancellations/:id/accept", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return acceptFundedCancellation(
        secured.prisma,
        user.id,
        id,
        requireIdempotencyKey(request),
      );
    });

    secured.post("/api/dashboard/escrows/:id/fund", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return fundEscrow(secured.prisma, user.id, id, requireIdempotencyKey(request));
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/approve", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().max(2_000).optional() }).parse(request.body ?? {});
      return approveMilestone(
        secured.prisma,
        user.id,
        id,
        milestoneId,
        requireIdempotencyKey(request),
        reason,
      );
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/reject", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(3).max(2_000) }).parse(request.body);
      const result = await rejectMilestone(secured.prisma, user.id, id, milestoneId, reason);
      return {
        success: true,
        escrowId: result.escrow.reference,
        milestoneId: result.milestone.id,
        rejectedAt: result.milestone.rejectedAt?.toISOString() ?? nowIso(),
      };
    });

    const handleMilestoneSubmission = async (request: FastifyRequest) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const body = milestoneSubmissionSchema.parse(request.body ?? {});
      return resubmitMilestone(
        secured.prisma,
        user.id,
        id,
        milestoneId,
        body,
        requireIdempotencyKey(request),
      );
    };

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/submit", handleMilestoneSubmission);
    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/resubmit", handleMilestoneSubmission);

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/dispute", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(10).max(5_000) }).parse(request.body);
      return openMilestoneDispute(
        secured.prisma,
        user.id,
        id,
        milestoneId,
        reason,
        requireIdempotencyKey(request),
      );
    });

    const handleAgreementChangeRequest = async (request: FastifyRequest) => {
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
    };

    secured.post("/api/dashboard/escrows/:id/request-changes", handleAgreementChangeRequest);
    secured.post("/api/dashboard/escrows/:id/agreement-changes", handleAgreementChangeRequest);

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
      const dispute = await secured.prisma.dispute.findFirst({
        where: {
          reference: id,
          OR: [
            { ownerId: user.id },
            { escrow: { OR: [{ buyerId: user.id }, { sellerId: user.id }] } },
          ],
        },
      });
      if (!dispute) throw new AppError("Dispute not found.", 404);
      await secured.prisma.dispute.update({
        where: { id: dispute.id },
        data: { workspaceLaunched: true, updatedLabel: "Workspace launched just now" },
      });
      return { disputeId: id, launchedAt: nowIso() };
    });

    secured.post("/api/dashboard/disputes/:id/evidence", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = disputeEvidenceSchema.parse(request.body ?? {});
      return submitDisputeEvidence(
        secured.prisma,
        user.id,
        id,
        body,
        requireIdempotencyKey(request),
      );
    });

    secured.post("/api/dashboard/disputes/:id/resolution", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const body = disputeResolutionSchema.parse(request.body);
      return proposeDisputeResolution(
        secured.prisma,
        user.id,
        id,
        dollarsToCents(body.sellerAmount),
        dollarsToCents(body.buyerAmount),
        body.note,
        requireIdempotencyKey(request),
      );
    });

    secured.post("/api/dashboard/disputes/:id/arbitration", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return requestDisputeArbitration(
        secured.prisma,
        user.id,
        id,
        requireIdempotencyKey(request),
      );
    });

    secured.post("/api/dashboard/disputes/:id/resolve", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return acceptDisputeResolution(
        secured.prisma,
        user.id,
        id,
        requireIdempotencyKey(request),
      );
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
      const updatedUser = await recordStandaloneWalletTransfer(secured.prisma, {
        userId: user.id,
        amountCents: cents,
        type: "TOPUP",
      }, requireIdempotencyKey(request));
      return {
        success: true,
        amount,
        balance: Number((updatedUser.balanceCents / 100).toFixed(2)),
      };
    });

    secured.post("/api/dashboard/wallet/withdraw", async (request) => {
      const user = await requireUser(request);
      const { amount } = walletSchema.parse(request.body);
      const cents = dollarsToCents(amount);
      const updatedUser = await recordStandaloneWalletTransfer(secured.prisma, {
        userId: user.id,
        amountCents: -cents,
        type: "WITHDRAW",
      }, requireIdempotencyKey(request));
      return {
        success: true,
        amount,
        balance: Number((updatedUser.balanceCents / 100).toFixed(2)),
      };
    });

    secured.get("/api/dashboard/wallet/transactions", async (request) => {
      const user = await requireUser(request);
      const transactions = await listWalletTransactions(secured.prisma, user.id);
      return { transactions };
    });
  });
}
