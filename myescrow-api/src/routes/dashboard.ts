import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  fundMilestone,
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
  authorizeDisputeEvidenceUpload,
  openMilestoneDispute,
  proposeDisputeResolution,
  requestDisputeArbitration,
  requestFundedCancellation,
  submitCancellationInformation,
  submitDisputeEvidence,
} from "../services/disputeService";
import { listEscrowMessages, sendEscrowMessage } from "../services/chatService";
import { getArbitrationReport } from "../services/arbitrationReportService";
import {
  agreementDraftStateResponse,
  getAgreementDraft,
  saveAgreementDraft,
  tombstoneAgreementDraft,
} from "../services/agreementDraftService";
import { sendMilestoneChangeRequestEmail } from "../services/emailService";
import { processInvitationOutbox } from "../services/invitationService";
import {
  authorizeMilestoneProofUpload,
  openMilestoneProof,
  parseDisputeEvidenceSubmission,
  parseMilestoneProofSubmission,
  removeMilestoneProofs,
  removeStoredEvidenceFiles,
} from "../services/milestoneProofService";
import { findUserById } from "../services/userService";
import { recordStandaloneWalletTransfer } from "../services/moneyIntegrityService";
import { AppError } from "../utils/errors";
import { dollarsToCents } from "../utils/currency";
import { nowIso } from "../utils/dates";
import { attachmentContentDisposition } from "../utils/contentDisposition";

const signatureDataUrlSchema = z
  .string()
  .max(500_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Signature must be a PNG data URL.");

const maximumExactDollarAmount = Number.MAX_SAFE_INTEGER / 100;
const positiveMoneySchema = z.number().positive().max(
  maximumExactDollarAmount,
  "Amount exceeds the supported exact-cent range.",
);
const nonnegativeMoneySchema = z.number().nonnegative().max(
  maximumExactDollarAmount,
  "Amount exceeds the supported exact-cent range.",
);
const draftRevisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
  amount: positiveMoneySchema,
  draftRevision: draftRevisionSchema.optional(),
  fundingMode: z.enum(["full", "milestone"]).optional(),
  creatorRole: z.enum(["buyer", "seller"]).default("buyer"),
  creatorParty: partyIdentitySchema.default({ type: "individual" }),
  category: z.string().optional(),
  description: z.string().optional(),
  signatureDataUrl: signatureDataUrlSchema,
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      amount: positiveMoneySchema,
      description: z.string().optional(),
      deadline: z.string().datetime().optional(),
    }),
  ).optional(),
});

const updateDraftEscrowSchema = z.object({
  title: z.string().min(2),
  counterpartyEmail: z.string().email(),
  amount: positiveMoneySchema,
  description: z.string().optional(),
  milestones: z.array(
    z.object({
      title: z.string().min(1),
      amount: positiveMoneySchema,
      description: z.string().optional(),
      deadline: z.string().datetime().optional(),
    }),
  ).optional(),
});

const draftCurrencyInputSchema = z
  .string()
  .max(32)
  .regex(/^(?:\d+(?:\.\d{0,2})?)?$/, "Amount must be a decimal value with at most two decimal places.");
const draftDateInputSchema = z
  .string()
  .max(10)
  .regex(/^(?:|\d{4}-\d{2}-\d{2})$/, "Deadline must be blank or use YYYY-MM-DD.");
const draftMilestoneIdSchema = z.string().min(1).max(100);
const agreementDraftSchema = z.object({
  schemaVersion: z.literal(1),
  screen: z.enum(["create", "milestones", "agreement"]),
  createPromptStep: z.number().int().min(0).max(6),
  createForm: z.object({
    role: z.enum(["buyer", "seller"]),
    counterpartyEmail: z.string().max(320),
    counterpartyEmailConfirmation: z.string().max(320),
    title: z.string().max(200),
    amount: draftCurrencyInputSchema,
    category: z.string().max(100),
    description: z.string().max(10_000),
    fundingMode: z.enum(["full", "milestone"]).nullable(),
    partyType: z.enum(["individual", "business"]),
    business: z.object({
      legalName: z.string().max(200),
      representativeTitle: z.string().max(200),
    }).strict(),
  }).strict(),
  descriptionSkipped: z.boolean(),
  milestones: z.array(z.object({
    id: draftMilestoneIdSchema,
    title: z.string().max(200),
    amount: nonnegativeMoneySchema,
    description: z.string().max(5_000),
    deadline: draftDateInputSchema,
  }).strict()).max(100),
  milestoneInputs: z.object({
    title: z.string().max(200),
    amount: draftCurrencyInputSchema,
    description: z.string().max(5_000),
    deadline: draftDateInputSchema,
  }).strict(),
  editingMilestoneId: draftMilestoneIdSchema.nullable(),
}).strict();
const saveAgreementDraftSchema = z.object({
  baseRevision: draftRevisionSchema,
  draft: agreementDraftSchema,
}).strict();
const deleteAgreementDraftSchema = z.object({
  baseRevision: draftRevisionSchema,
}).strict();

const milestoneSubmissionSchema = z.object({
  note: z.string().trim().max(5_000).optional(),
}).strict();

const disputeEvidenceSchema = z.object({
  note: z.string().trim().max(5_000).optional(),
}).strict();

const disputeResolutionSchema = z.object({
  sellerAmount: nonnegativeMoneySchema,
  buyerAmount: nonnegativeMoneySchema,
  note: z.string().trim().max(5_000).optional(),
});

const fundedCancellationSchema = z.object({
  mode: z.enum(["mutual", "unilateral"]),
  reason: z.string().trim().min(10).max(5_000),
});
const cancellationInformationSchema = z.object({
  requestMessageId: z.number().int().positive(),
  note: z.string().trim().min(10).max(5_000),
});

const walletSchema = z.object({
  amount: positiveMoneySchema,
});

const stagedFundingSchema = z.object({
  amount: positiveMoneySchema.optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });
const notificationQuerySchema = z.object({ history: z.coerce.boolean().optional().default(false) });
const chatQuerySchema = z.object({
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100),
});
const chatMessageSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty.").max(5_000),
});
const milestoneParamsSchema = z.object({
  id: z.string().min(1),
  milestoneId: z.coerce.number().int().positive(),
});
const milestoneEvidenceParamsSchema = milestoneParamsSchema.extend({
  submissionId: z.coerce.number().int().positive(),
  evidenceId: z.coerce.number().int().positive(),
});
const milestoneChangeRequestSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  amount: positiveMoneySchema,
  deadline: z.string().datetime().optional(),
  note: z.string().max(1000).optional(),
});

const milestoneChangeReviewSchema = z.object({
  decision: z.enum(["accept", "reject"]).default("accept"),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  amount: positiveMoneySchema.optional(),
  deadline: z.string().datetime().nullable().optional(),
});

const agreementMilestoneChangeSchema = z.object({
  milestoneId: z.coerce.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  amount: positiveMoneySchema,
  deadline: z.string().datetime().optional(),
});

const agreementChangeRequestSchema = z.object({
  milestones: z.array(agreementMilestoneChangeSchema).min(1),
  note: z.string().max(1000).optional(),
});

const agreementChangeReviewSchema = z.object({
  decision: z.enum(["accept", "counter", "reject"]).default("accept"),
  milestones: z.array(agreementMilestoneChangeSchema).optional(),
}).superRefine((review, context) => {
  if (review.decision === "counter" && !review.milestones?.length) {
    context.addIssue({
      code: "custom",
      path: ["milestones"],
      message: "A counterproposal must include milestone terms.",
    });
  }
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
      if (request.user.portal !== "customer") {
        throw new AppError("A customer portal session is required.", 403);
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
      return { escrows, fundingPlanSelectionSupported: true };
    });

    secured.get("/api/dashboard/escrows/:id/ledger", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return getEscrowLedgerHistory(secured.prisma, user.id, id);
    });

    secured.get("/api/dashboard/escrows/:id/messages", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const query = chatQuerySchema.parse(request.query);
      return listEscrowMessages(secured.prisma, user.id, id, {
        limit: query.limit,
        ...(query.beforeId ? { beforeId: query.beforeId } : {}),
      });
    });

    secured.post("/api/dashboard/escrows/:id/messages", async (request, reply) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const { body } = chatMessageSchema.parse(request.body);
      const result = await sendEscrowMessage(
        secured.prisma,
        user.id,
        id,
        body,
        requireIdempotencyKey(request),
      );
      reply.code(201);
      return result;
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

    secured.get("/api/dashboard/agreement-draft", async (request, reply) => {
      const user = await requireUser(request);
      const draft = await getAgreementDraft(secured.prisma, user.id);
      reply.header("Cache-Control", "private, no-store");
      return agreementDraftStateResponse(draft);
    });

    secured.put("/api/dashboard/agreement-draft", async (request) => {
      const user = await requireUser(request);
      const body = saveAgreementDraftSchema.parse(request.body);
      const { schemaVersion, ...data } = body.draft;
      const draft = await saveAgreementDraft(secured.prisma, user.id, {
        baseRevision: body.baseRevision,
        schemaVersion,
        data,
      });
      return agreementDraftStateResponse(draft);
    });

    secured.delete("/api/dashboard/agreement-draft", async (request) => {
      const user = await requireUser(request);
      const body = deleteAgreementDraftSchema.parse(request.body);
      const draft = await tombstoneAgreementDraft(secured.prisma, user.id, body.baseRevision);
      return { success: true, ...agreementDraftStateResponse(draft) };
    });

    secured.post("/api/dashboard/escrows/create", async (request, reply) => {
      const user = await requireUser(request);
      const body = createEscrowSchema.parse(request.body);
      const result = await createEscrow(secured.prisma, user.id, {
        title: body.title,
        counterpartyEmail: body.counterpartyEmail,
        amount: body.amount,
        ...(body.draftRevision !== undefined ? { draftRevision: body.draftRevision } : {}),
        ...(body.fundingMode ? { fundingMode: body.fundingMode } : {}),
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

    secured.post("/api/dashboard/cancellations/:id/information", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      const { requestMessageId, note } = cancellationInformationSchema.parse(request.body);
      return submitCancellationInformation(
        secured.prisma,
        user.id,
        id,
        requestMessageId,
        note,
        requireIdempotencyKey(request),
      );
    });

    secured.post("/api/dashboard/escrows/:id/fund", async (request) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      return fundEscrow(secured.prisma, user.id, id, requireIdempotencyKey(request));
    });

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/fund", async (request) => {
      const user = await requireUser(request);
      const { id, milestoneId } = milestoneParamsSchema.parse(request.params);
      const { amount } = stagedFundingSchema.parse(request.body ?? {});
      return fundMilestone(
        secured.prisma,
        user.id,
        id,
        milestoneId,
        requireIdempotencyKey(request),
        amount === undefined ? undefined : dollarsToCents(amount),
      );
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
      const isMultipart = request.isMultipart();
      if (isMultipart) {
        await authorizeMilestoneProofUpload(secured.prisma, user.id, id, milestoneId);
      }
      const parsed = isMultipart
        ? await parseMilestoneProofSubmission(request)
        : { input: milestoneSubmissionSchema.parse(request.body ?? {}), storedEvidence: [] };
      try {
        const result = await resubmitMilestone(
          secured.prisma,
          user.id,
          id,
          milestoneId,
          parsed.input,
          requireIdempotencyKey(request),
        );
        if (result.replayed) {
          await removeMilestoneProofs(parsed.storedEvidence);
        }
        return result;
      } catch (error) {
        await removeMilestoneProofs(parsed.storedEvidence);
        throw error;
      }
    };

    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/submit", handleMilestoneSubmission);
    secured.post("/api/dashboard/escrows/:id/milestones/:milestoneId/resubmit", handleMilestoneSubmission);
    secured.get(
      "/api/dashboard/escrows/:id/milestones/:milestoneId/submissions/:submissionId/evidence/:evidenceId",
      async (request, reply: FastifyReply) => {
        const user = await requireUser(request);
        const { id, milestoneId, submissionId, evidenceId } = milestoneEvidenceParamsSchema.parse(request.params);
        const { evidence, stream } = await openMilestoneProof(
          secured.prisma,
          user.id,
          id,
          milestoneId,
          submissionId,
          evidenceId,
        );
        reply
          .header("Cache-Control", "private, no-store")
          .header("Content-Disposition", attachmentContentDisposition(evidence.fileName))
          .header("Content-Length", evidence.sizeBytes)
          .header("Content-Type", evidence.contentType)
          .header("X-Content-Type-Options", "nosniff");
        return reply.send(stream);
      },
    );

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
          agreementLevel: true,
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

    secured.get("/api/dashboard/disputes/:id/arbitration-report", async (request, reply) => {
      const user = await requireUser(request);
      const { id } = idParamsSchema.parse(request.params);
      reply.header("Cache-Control", "private, no-store");
      return getArbitrationReport(secured.prisma, id, user.id);
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
      const isMultipart = request.isMultipart();
      if (isMultipart) {
        await authorizeDisputeEvidenceUpload(secured.prisma, user.id, id);
      }
      const parsed = isMultipart
        ? await parseDisputeEvidenceSubmission(request)
        : null;
      try {
        const result = await submitDisputeEvidence(
          secured.prisma,
          user.id,
          id,
          parsed
            ? {
                ...(parsed.input.note !== undefined ? { note: parsed.input.note } : {}),
                storedEvidence: parsed.storedEvidence,
              }
            : disputeEvidenceSchema.parse(request.body ?? {}),
          requireIdempotencyKey(request),
        );
        if (result.replayed && parsed) {
          await removeStoredEvidenceFiles(parsed.storedEvidence);
        }
        return result;
      } catch (error) {
        if (parsed) {
          await removeStoredEvidenceFiles(parsed.storedEvidence);
        }
        throw error;
      }
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
