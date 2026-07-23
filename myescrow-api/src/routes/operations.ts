import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  getEscrowAuditTrail,
  getOperationsHealth,
  retryInvitationOutboxEvent,
  retryOperationalJob,
  supportExtendInvitation,
} from "../services/operationsService";
import { AppError } from "../utils/errors";
import { changeOperatorRole, listOperators } from "../services/operatorService";

const idSchema = z.object({ id: z.coerce.number().int().positive() });
const escrowSchema = z.object({ id: z.string().min(1) });

function requireIdempotencyKey(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 200) {
    throw new AppError("A valid Idempotency-Key header is required for this command.", 400);
  }
  return value.trim();
}

export async function operationsRoutes(fastify: FastifyInstance) {
  fastify.register(async (secured) => {
    secured.addHook("onRequest", secured.authenticate);

    const requireUser = async (request: FastifyRequest) => {
      const userId = request.user?.userId;
      if (!userId) throw new AppError("User not found.", 401);
      const user = await secured.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new AppError("User not found.", 401);
      return user;
    };

    const requireOperator = async (request: FastifyRequest) => {
      const user = await requireUser(request);
      if (!["support", "admin"].includes(user.role)) {
        throw new AppError("Support access is required.", 403);
      }
      return user;
    };

    const requireAdmin = async (request: FastifyRequest) => {
      const user = await requireUser(request);
      if (user.role !== "admin") throw new AppError("Administrator access is required.", 403);
      return user;
    };

    secured.get("/api/dashboard/escrows/:id/audit", async (request) => {
      const user = await requireUser(request);
      const { id } = escrowSchema.parse(request.params);
      return getEscrowAuditTrail(secured.prisma, user.id, id);
    });

    secured.get("/api/operations/health", async (request) => {
      const operator = await requireOperator(request);
      return { ...(await getOperationsHealth(secured.prisma)), currentRole: operator.role };
    });

    secured.get("/api/operations/operators", async (request) => {
      await requireAdmin(request);
      return { operators: await listOperators(secured.prisma) };
    });

    secured.post("/api/operations/operators/role", async (request) => {
      const admin = await requireAdmin(request);
      const { email, role } = z.object({
        email: z.string().email(),
        role: z.enum(["customer", "support", "admin"]),
      }).parse(request.body);
      return changeOperatorRole(secured.prisma, admin.id, email, role, requireIdempotencyKey(request));
    });

    secured.get("/api/operations/jobs", async (request) => {
      await requireOperator(request);
      const { status } = z.object({ status: z.enum(["pending", "processing", "completed", "failed"]).optional() }).parse(request.query);
      const jobs = await secured.prisma.operationalJob.findMany({
        ...(status ? { where: { status } } : {}),
        orderBy: [{ status: "asc" }, { runAt: "asc" }],
        take: 200,
      });
      return { jobs };
    });

    secured.get("/api/operations/escrows/:id/audit", async (request) => {
      const operator = await requireOperator(request);
      const { id } = escrowSchema.parse(request.params);
      return getEscrowAuditTrail(secured.prisma, operator.id, id, true);
    });

    secured.get("/api/operations/disputes/:id/evidence", async (request) => {
      await requireOperator(request);
      const { id } = escrowSchema.parse(request.params);
      const dispute = await secured.prisma.dispute.findUnique({
        where: { reference: id },
        include: {
          evidenceSubmissions: { include: { submitter: { select: { id: true, name: true } } }, orderBy: { submittedAt: "asc" } },
          escrow: { select: { reference: true } },
        },
      });
      if (!dispute) throw new AppError("Dispute not found.", 404);
      return { disputeId: dispute.reference, escrowId: dispute.escrow?.reference, evidence: dispute.evidenceSubmissions };
    });

    secured.post("/api/operations/jobs/:id/retry", async (request) => {
      const operator = await requireOperator(request);
      const { id } = idSchema.parse(request.params);
      return retryOperationalJob(secured.prisma, operator.id, id, requireIdempotencyKey(request));
    });

    secured.post("/api/operations/outbox/:id/retry", async (request) => {
      const operator = await requireOperator(request);
      const { id } = idSchema.parse(request.params);
      return retryInvitationOutboxEvent(secured.prisma, operator.id, id, requireIdempotencyKey(request));
    });

    secured.post("/api/operations/invitations/:id/extend", async (request) => {
      const operator = await requireOperator(request);
      const { id } = idSchema.parse(request.params);
      const { days } = z.object({ days: z.number().int().min(1).max(30).default(7) }).parse(request.body ?? {});
      return supportExtendInvitation(secured.prisma, operator.id, id, days, requireIdempotencyKey(request));
    });
  });
}
