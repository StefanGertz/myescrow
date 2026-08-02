import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";
import { executeIdempotentCommand } from "./idempotencyService";
import { normalizeEmail } from "./userService";
import { recordAuditEvent } from "./operationsService";

export type ManagedRole = "customer" | "support" | "admin";

export async function bootstrapFirstAdmin(prisma: PrismaClient, email: string) {
  const normalizedEmail = normalizeEmail(email);
  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { email: normalizedEmail } });
    if (!target) throw new AppError("The bootstrap account must already exist.", 404);
    if (!target.emailVerified) throw new AppError("The bootstrap account must have a verified email.", 409);
    if (target.operatorRole === "admin") return { success: true, userId: target.id, email: target.email, role: "admin" as const, changed: false };
    const adminCount = await tx.user.count({ where: { operatorRole: "admin" } });
    if (adminCount > 0) {
      throw new AppError("An administrator already exists. Use the audited admin role-management API.", 409);
    }
    await tx.user.update({ where: { id: target.id }, data: { operatorRole: "admin" } });
    await recordAuditEvent(tx, {
      dedupeKey: `operator-bootstrap:${target.id}`,
      actorType: "system",
      action: "operator_role.bootstrapped",
      entityType: "user",
      entityId: target.id,
      outcome: "admin_granted",
      metadata: { email: target.email, previousRole: target.operatorRole, newRole: "admin" },
    });
    return { success: true, userId: target.id, email: target.email, role: "admin" as const, changed: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function listOperators(prisma: PrismaClient) {
  const operators = await prisma.user.findMany({
    where: { operatorRole: { in: ["support", "admin"] } },
    select: { id: true, name: true, email: true, operatorRole: true, emailVerified: true, updatedAt: true },
    orderBy: [{ operatorRole: "asc" }, { name: "asc" }],
  });
  return operators.map(({ operatorRole, ...operator }) => ({ ...operator, role: operatorRole }));
}

export async function changeOperatorRole(
  prisma: PrismaClient,
  actorId: string,
  targetEmail: string,
  role: ManagedRole,
  idempotencyKey: string,
) {
  const email = normalizeEmail(targetEmail);
  return executeIdempotentCommand(prisma, {
    userId: actorId,
    key: idempotencyKey,
    command: "admin_change_operator_role",
    payload: { email, role },
  }, async (tx) => {
    const actor = await tx.user.findUnique({ where: { id: actorId } });
    if (!actor || actor.operatorRole !== "admin") throw new AppError("Administrator access is required.", 403);
    const target = await tx.user.findUnique({ where: { email } });
    if (!target) throw new AppError("User not found.", 404);
    if (!target.emailVerified) throw new AppError("Operator access requires a verified email.", 409);
    if (target.operatorRole === "admin" && role !== "admin") {
      const adminCount = await tx.user.count({ where: { operatorRole: "admin" } });
      if (adminCount <= 1) throw new AppError("The final administrator cannot be demoted.", 409);
    }
    const nextOperatorRole = role === "customer" ? null : role;
    if (target.operatorRole !== nextOperatorRole) {
      await tx.user.update({ where: { id: target.id }, data: { operatorRole: nextOperatorRole } });
      await recordAuditEvent(tx, {
        actorId,
        actorType: "support",
        action: "operator_role.changed",
        entityType: "user",
        entityId: target.id,
        outcome: role === "customer" ? "access_revoked" : "access_granted",
        metadata: { email: target.email, previousRole: target.operatorRole, newRole: nextOperatorRole },
      });
    }
    return { success: true, userId: target.id, email: target.email, role };
  });
}
