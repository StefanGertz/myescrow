import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  getEscrowAuditTrail,
  getOperationsHealth,
  retryInvitationOutboxEvent,
  retryOperationalJob,
  supportExtendInvitation,
} from "../services/operationsService";
import {
  getArbitrationReport,
  openArbitrationExhibit,
} from "../services/arbitrationReportService";
import { AppError } from "../utils/errors";
import { changeOperatorRole, listOperators } from "../services/operatorService";
import { getEscrowForOperations } from "../services/dashboardService";
import { attachmentContentDisposition } from "../utils/contentDisposition";

const idSchema = z.object({ id: z.coerce.number().int().positive() });
const escrowSchema = z.object({ id: z.string().min(1) });
const arbitrationExhibitSchema = z.object({
  id: z.string().min(1),
  exhibitId: z.string().regex(/^(milestone|dispute)-[1-9]\d*$/),
});

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

    secured.get("/api/operations/escrows/:id", async (request) => {
      await requireOperator(request);
      const { id } = escrowSchema.parse(request.params);
      return { escrow: await getEscrowForOperations(secured.prisma, id) };
    });

    secured.get(
      "/api/arbitration/disputes/:id/exhibits/:exhibitId",
      async (request, reply: FastifyReply) => {
        const user = await requireUser(request);
        const { id, exhibitId } = arbitrationExhibitSchema.parse(request.params);
        const { evidence, bytes } = await openArbitrationExhibit(
          secured.prisma,
          id,
          exhibitId,
          user,
        );
        reply
          .header("Cache-Control", "private, no-store")
          .header("Content-Disposition", attachmentContentDisposition(evidence.fileName))
          .header("Content-Length", evidence.sizeBytes)
          .header("Content-Type", evidence.contentType)
          .header("X-Content-SHA256", evidence.sha256.toLowerCase())
          .header("X-Content-Type-Options", "nosniff");
        return reply.send(bytes);
      },
    );

    secured.get("/api/operations/disputes/:id/evidence", async (request, reply) => {
      await requireOperator(request);
      const { id } = escrowSchema.parse(request.params);
      reply.header("Cache-Control", "private, no-store");
      return getArbitrationReport(secured.prisma, id);
    });

    secured.get("/api/operations/disputes/:id/arbitration-report", async (request, reply) => {
      await requireOperator(request);
      const { id } = escrowSchema.parse(request.params);
      reply.header("Cache-Control", "private, no-store");
      return getArbitrationReport(secured.prisma, id);
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
