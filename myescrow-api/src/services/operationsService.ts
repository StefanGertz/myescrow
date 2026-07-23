import type { FastifyBaseLogger } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../utils/errors";
import { buildNotificationId } from "../utils/id";
import { executeIdempotentCommand } from "./idempotencyService";
import { extendInvitationDelivery, processInvitationOutbox } from "./invitationService";
import { processMilestoneReviewDeadlines } from "./milestoneReviewService";
import { reconcileEscrowLedger } from "./moneyIntegrityService";
import { getNextSequenceValue } from "./sequenceService";

const DAY_MS = 86_400_000;
const ACTIVE_ESCROW_STATES = [
  "pending_counterparty_signup",
  "pending_approval",
  "changes_requested",
  "creator_signature_required",
  "funding_pending",
  "funded",
  "cancellation_pending",
  "cancellation_review",
  "dispute_resolution_pending",
];
const ACTIVE_DISPUTE_STATES = ["open", "resolution_proposed", "resolving", "arbitration_requested"];

type DbClient = PrismaClient | Prisma.TransactionClient;

async function createNotification(
  tx: Prisma.TransactionClient,
  userId: string,
  label: string,
  detail: string,
  escrowId?: number,
) {
  await tx.notification.create({
    data: {
      id: buildNotificationId(await getNextSequenceValue(tx, "notification", 1)),
      userId,
      label,
      detail,
      meta: "Just now",
      ...(escrowId ? { txId: escrowId } : {}),
    },
  });
}

export async function recordAuditEvent(
  prisma: DbClient,
  input: {
    dedupeKey?: string;
    escrowId?: number;
    actorId?: string;
    actorType: "user" | "support" | "system";
    action: string;
    entityType: string;
    entityId: string;
    outcome: string;
    metadata?: Prisma.InputJsonObject;
  },
) {
  const data = {
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    ...(input.escrowId ? { escrowId: input.escrowId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    actorType: input.actorType,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    outcome: input.outcome,
    metadata: input.metadata ?? {},
  };
  if (!input.dedupeKey) return prisma.auditEvent.create({ data });
  return prisma.auditEvent.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: data,
    update: {},
  });
}

function utcDayKey(now: Date) {
  return now.toISOString().slice(0, 10);
}

function utcHourKey(now: Date) {
  return now.toISOString().slice(0, 13);
}

export async function scheduleOperationalJobs(prisma: PrismaClient, now = new Date()) {
  const [deliveries, fundingEscrows, disputes, cancellations] = await Promise.all([
    prisma.invitationDelivery.findMany({
      where: {
        supersededAt: null,
        acceptedAt: null,
        status: { notIn: ["accepted", "corrected", "expired"] },
      },
      select: { id: true, responseDueAt: true, expiresAt: true },
    }),
    prisma.escrow.findMany({
      where: { lifecycleStatus: "funding_pending", approvedAt: { not: null } },
      select: { id: true, approvedAt: true },
    }),
    prisma.dispute.findMany({
      where: { status: { in: ACTIVE_DISPUTE_STATES }, evidenceWindowEndsAt: { not: null } },
      select: { id: true, evidenceWindowEndsAt: true },
    }),
    prisma.cancellationRequest.findMany({
      where: { status: "pending", escalatedAt: null },
      select: { id: true, requestedAt: true },
    }),
  ]);
  const jobs: Prisma.OperationalJobCreateManyInput[] = [
    {
      jobType: "milestone_deadline_sweep",
      dedupeKey: `milestone-deadlines:${utcHourKey(now)}`,
      payload: {},
      runAt: now,
    },
    {
      jobType: "ledger_reconciliation",
      dedupeKey: `ledger-reconciliation:${utcDayKey(now)}`,
      payload: {},
      runAt: now,
    },
  ];
  for (const delivery of deliveries) {
    jobs.push(
      {
        jobType: "invitation_response_reminder",
        dedupeKey: `invitation-response:${delivery.id}:${delivery.responseDueAt.toISOString()}`,
        payload: { deliveryId: delivery.id },
        runAt: delivery.responseDueAt,
      },
      {
        jobType: "invitation_expiry",
        dedupeKey: `invitation-expiry:${delivery.id}:${delivery.expiresAt.toISOString()}`,
        payload: { deliveryId: delivery.id },
        runAt: delivery.expiresAt,
      },
    );
  }
  for (const escrow of fundingEscrows) {
    jobs.push({
      jobType: "funding_timeout",
      dedupeKey: `funding-timeout:${escrow.id}:${escrow.approvedAt!.toISOString()}`,
      payload: { escrowId: escrow.id },
      runAt: new Date(escrow.approvedAt!.getTime() + 7 * DAY_MS),
    });
  }
  for (const dispute of disputes) {
    const deadline = dispute.evidenceWindowEndsAt!;
    jobs.push(
      {
        jobType: "dispute_evidence_reminder",
        dedupeKey: `dispute-evidence-reminder:${dispute.id}:${deadline.toISOString()}`,
        payload: { disputeId: dispute.id },
        runAt: new Date(deadline.getTime() - 2 * DAY_MS),
      },
      {
        jobType: "dispute_evidence_deadline",
        dedupeKey: `dispute-evidence-deadline:${dispute.id}:${deadline.toISOString()}`,
        payload: { disputeId: dispute.id },
        runAt: deadline,
      },
    );
  }
  for (const cancellation of cancellations) {
    jobs.push({
      jobType: "cancellation_response_deadline",
      dedupeKey: `cancellation-response:${cancellation.id}:${cancellation.requestedAt.toISOString()}`,
      payload: { cancellationId: cancellation.id },
      runAt: new Date(cancellation.requestedAt.getTime() + 3 * DAY_MS),
    });
  }
  const inserted = await prisma.operationalJob.createMany({ data: jobs, skipDuplicates: true });
  return { scheduled: inserted.count };
}

async function notifyEscrowParties(
  tx: Prisma.TransactionClient,
  escrow: { id: number; buyerId: string | null; sellerId: string | null },
  label: string,
  detail: string,
) {
  for (const userId of new Set([escrow.buyerId, escrow.sellerId].filter(Boolean) as string[])) {
    await createNotification(tx, userId, label, detail, escrow.id);
  }
}

async function runRecordedReconciliation(prisma: PrismaClient, now: Date) {
  const run = await prisma.reconciliationRun.create({ data: { status: "running", startedAt: now } });
  const report = await reconcileEscrowLedger(prisma);
  const hasExceptions = report.exceptions.length > 0;
  const operators = hasExceptions
    ? await prisma.user.findMany({ where: { role: { in: ["support", "admin"] } }, select: { id: true } })
    : [];
  await prisma.$transaction(async (tx) => {
    await tx.reconciliationRun.update({
      where: { id: run.id },
      data: {
        status: hasExceptions ? "exception" : "clean",
        checkedEscrows: report.checkedEscrows,
        exceptionCount: report.exceptions.length,
        report: report as unknown as Prisma.InputJsonObject,
        completedAt: now,
        ...(operators.length > 0 ? { alertedAt: now } : {}),
      },
    });
    if (hasExceptions) {
      for (const operator of operators) {
        await createNotification(
          tx,
          operator.id,
          "Ledger reconciliation exception",
          `${report.exceptions.length} escrow ledger exception(s) require review.`,
        );
      }
    }
    await recordAuditEvent(tx, {
      dedupeKey: `reconciliation-run:${run.id}`,
      actorType: "system",
      action: "ledger.reconciled",
      entityType: "reconciliation_run",
      entityId: String(run.id),
      outcome: hasExceptions ? "exception" : "clean",
      metadata: {
        checkedEscrows: report.checkedEscrows,
        exceptionCount: report.exceptions.length,
      },
    });
  });
  return report;
}

async function executeOperationalJob(prisma: PrismaClient, job: { id: number; jobType: string; payload: Prisma.JsonValue }, now: Date) {
  const payload = (job.payload ?? {}) as Record<string, unknown>;
  if (job.jobType === "milestone_deadline_sweep") {
    return processMilestoneReviewDeadlines(prisma, now);
  }
  if (job.jobType === "ledger_reconciliation") {
    return runRecordedReconciliation(prisma, now);
  }
  return prisma.$transaction(async (tx) => {
    if (job.jobType.startsWith("invitation_")) {
      const deliveryId = Number(payload.deliveryId);
      const delivery = await tx.invitationDelivery.findUnique({
        where: { id: deliveryId },
        include: { escrow: true },
      });
      if (!delivery || delivery.acceptedAt || delivery.supersededAt) return { skipped: true };
      if (job.jobType === "invitation_response_reminder") {
        await createNotification(
          tx,
          delivery.escrow.ownerId,
          "Invitation response overdue",
          `${delivery.escrow.reference} has not been accepted. You can correct, resend, or extend the invitation.`,
          delivery.escrow.id,
        );
      } else {
        const transition = await tx.invitationDelivery.updateMany({
          where: { id: delivery.id, acceptedAt: null, supersededAt: null },
          data: { status: "expired", nextAttemptAt: null },
        });
        if (transition.count !== 1) return { skipped: true };
        await tx.outboxEvent.updateMany({
          where: { invitationDeliveryId: delivery.id, status: { in: ["pending", "processing"] } },
          data: { status: "cancelled", processedAt: now },
        });
        await tx.escrow.updateMany({
          where: {
            id: delivery.escrow.id,
            lifecycleStatus: { in: ["pending_counterparty_signup", "pending_approval", "creator_signature_required", "changes_requested"] },
          },
          data: {
            lifecycleStatus: "invitation_expired",
            stage: "Invitation expired",
            dueDescription: "Creator can extend or resend the invitation",
            status: "warning",
          },
        });
        await createNotification(
          tx,
          delivery.escrow.ownerId,
          "Escrow invitation expired",
          `${delivery.escrow.reference} can be extended or resent without recreating the escrow.`,
          delivery.escrow.id,
        );
      }
      await recordAuditEvent(tx, {
        dedupeKey: `operational-job:${job.id}`,
        escrowId: delivery.escrow.id,
        actorType: "system",
        action: job.jobType,
        entityType: "invitation_delivery",
        entityId: String(delivery.id),
        outcome: "completed",
      });
      return { success: true };
    }
    if (job.jobType === "funding_timeout") {
      const escrowId = Number(payload.escrowId);
      const escrow = await tx.escrow.findUnique({ where: { id: escrowId } });
      if (!escrow || escrow.lifecycleStatus !== "funding_pending") return { skipped: true };
      await tx.escrow.update({
        where: { id: escrow.id },
        data: { stage: "Funding overdue", dueDescription: "Buyer must fund or cancel the escrow", status: "warning" },
      });
      await notifyEscrowParties(tx, escrow, "Escrow funding overdue", `${escrow.reference} remains unfunded. No money has moved.`);
      await recordAuditEvent(tx, {
        dedupeKey: `operational-job:${job.id}`,
        escrowId: escrow.id,
        actorType: "system",
        action: "funding.escalated",
        entityType: "escrow",
        entityId: escrow.reference,
        outcome: "overdue",
      });
      return { success: true };
    }
    if (job.jobType.startsWith("dispute_evidence_")) {
      const disputeId = Number(payload.disputeId);
      const dispute = await tx.dispute.findUnique({ where: { id: disputeId }, include: { escrow: true } });
      if (!dispute?.escrow || !ACTIVE_DISPUTE_STATES.includes(dispute.status)) return { skipped: true };
      const reminder = job.jobType === "dispute_evidence_reminder";
      const transition = await tx.dispute.updateMany({
        where: { id: dispute.id, status: { in: ACTIVE_DISPUTE_STATES } },
        data: reminder
          ? { evidenceReminderSentAt: now }
          : { evidenceEscalatedAt: now, updatedLabel: "Evidence window closed; resolution required" },
      });
      if (transition.count !== 1) return { skipped: true };
      await notifyEscrowParties(
        tx,
        dispute.escrow,
        reminder ? "Dispute evidence deadline approaching" : "Dispute evidence window closed",
        reminder
          ? `${dispute.reference} has two days remaining for evidence.`
          : `${dispute.reference} now requires a complete settlement proposal or support review.`,
      );
      await recordAuditEvent(tx, {
        dedupeKey: `operational-job:${job.id}`,
        escrowId: dispute.escrow.id,
        actorType: "system",
        action: job.jobType,
        entityType: "dispute",
        entityId: dispute.reference,
        outcome: reminder ? "reminded" : "escalated",
      });
      return { success: true };
    }
    if (job.jobType === "cancellation_response_deadline") {
      const cancellationId = Number(payload.cancellationId);
      const cancellation = await tx.cancellationRequest.findUnique({
        where: { id: cancellationId },
        include: { escrow: true },
      });
      if (!cancellation || cancellation.status !== "pending") return { skipped: true };
      await tx.cancellationRequest.update({ where: { id: cancellation.id }, data: { escalatedAt: now } });
      await tx.escrow.update({
        where: { id: cancellation.escrow.id },
        data: { stage: "Cancellation response overdue", dueDescription: "Counterparty response or support review required", status: "warning" },
      });
      await notifyEscrowParties(
        tx,
        cancellation.escrow,
        "Cancellation response overdue",
        `${cancellation.reference} remains open; no disputed funds have moved.`,
      );
      await recordAuditEvent(tx, {
        dedupeKey: `operational-job:${job.id}`,
        escrowId: cancellation.escrow.id,
        actorType: "system",
        action: "cancellation.escalated",
        entityType: "cancellation_request",
        entityId: cancellation.reference,
        outcome: "overdue",
      });
      return { success: true };
    }
    throw new AppError(`Unsupported operational job type: ${job.jobType}`, 500);
  });
}

async function performOperationalRecovery(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
  now = new Date(),
  limit = 50,
) {
  const staleLock = new Date(now.getTime() - 10 * 60_000);
  await prisma.operationalJob.updateMany({
    where: { status: "processing", lockedAt: { lt: staleLock } },
    data: { status: "pending", lockedAt: null, lastError: "Recovered stale worker lock" },
  });
  const invitationResult = await processInvitationOutbox(prisma, logger, limit);
  const scheduled = await scheduleOperationalJobs(prisma, now);
  const jobs = await prisma.operationalJob.findMany({
    where: { status: "pending", runAt: { lte: now } },
    orderBy: [{ runAt: "asc" }, { id: "asc" }],
    take: limit,
  });
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    const claimed = await prisma.operationalJob.updateMany({
      where: { id: job.id, status: "pending" },
      data: { status: "processing", lockedAt: now },
    });
    if (claimed.count !== 1) continue;
    try {
      await executeOperationalJob(prisma, job, now);
      await prisma.operationalJob.update({
        where: { id: job.id },
        data: { status: "completed", completedAt: now, lockedAt: null, lastError: null },
      });
      completed += 1;
    } catch (error) {
      const attempts = job.attemptCount + 1;
      const terminal = attempts >= job.maxAttempts;
      await prisma.operationalJob.update({
        where: { id: job.id },
        data: {
          status: terminal ? "failed" : "pending",
          attemptCount: attempts,
          lockedAt: null,
          lastError: error instanceof Error ? error.message : "Unknown operational job error",
          runAt: terminal ? job.runAt : new Date(now.getTime() + Math.min(60, 2 ** attempts) * 60_000),
        },
      });
      failed += 1;
    }
  }
  return { invitations: invitationResult, scheduled: scheduled.scheduled, processed: completed + failed, completed, failed };
}

export async function runOperationalRecovery(
  prisma: PrismaClient,
  logger: FastifyBaseLogger,
  now = new Date(),
  limit = 50,
) {
  await prisma.operationalWorkerState.upsert({
    where: { id: "primary" },
    create: { id: "primary", lastStartedAt: now },
    update: { lastStartedAt: now },
  });
  try {
    const result = await performOperationalRecovery(prisma, logger, now, limit);
    await prisma.operationalWorkerState.update({
      where: { id: "primary" },
      data: { lastCompletedAt: new Date(), lastSuccessAt: new Date(), lastError: null },
    });
    return result;
  } catch (error) {
    await prisma.operationalWorkerState.update({
      where: { id: "primary" },
      data: {
        lastCompletedAt: new Date(),
        lastError: error instanceof Error ? error.message : "Unknown operational worker error",
      },
    });
    throw error;
  }
}

export async function getOperationsHealth(prisma: PrismaClient, now = new Date()) {
  const approaching = new Date(now.getTime() + 2 * DAY_MS);
  const agedBefore = new Date(now.getTime() - 7 * DAY_MS);
  const [
    failedOutbox,
    failedJobs,
    agedEscrows,
    duplicateCommands,
    disputesApproaching,
    latestReconciliation,
    worker,
    failedOutboxDetails,
    failedJobDetails,
    agedEscrowDetails,
    duplicateCommandDetails,
    disputeDetails,
  ] = await Promise.all([
    prisma.outboxEvent.count({ where: { status: "failed" } }),
    prisma.operationalJob.count({ where: { status: "failed" } }),
    prisma.escrow.count({ where: { lifecycleStatus: { in: ACTIVE_ESCROW_STATES }, updatedAt: { lt: agedBefore } } }),
    prisma.idempotencyRecord.aggregate({ _sum: { replayCount: true } }),
    prisma.dispute.count({
      where: {
        status: { in: ACTIVE_DISPUTE_STATES },
        evidenceWindowEndsAt: { gt: now, lte: approaching },
      },
    }),
    prisma.reconciliationRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.operationalWorkerState.findUnique({ where: { id: "primary" } }),
    prisma.outboxEvent.findMany({
      where: { status: "failed" },
      select: {
        id: true,
        eventType: true,
        status: true,
        attemptCount: true,
        nextAttemptAt: true,
        lastError: true,
        updatedAt: true,
        invitationDelivery: {
          select: {
            recipient: true,
            escrow: { select: { reference: true, title: true } },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.operationalJob.findMany({
      where: { status: "failed" },
      select: {
        id: true,
        jobType: true,
        status: true,
        attemptCount: true,
        maxAttempts: true,
        runAt: true,
        lastError: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
    prisma.escrow.findMany({
      where: { lifecycleStatus: { in: ACTIVE_ESCROW_STATES }, updatedAt: { lt: agedBefore } },
      select: {
        reference: true,
        title: true,
        lifecycleStatus: true,
        fundingStatus: true,
        amountCents: true,
        counterpartyEmail: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "asc" },
      take: 100,
    }),
    prisma.idempotencyRecord.findMany({
      where: { replayCount: { gt: 0 } },
      select: {
        id: true,
        command: true,
        replayCount: true,
        lastReplayedAt: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ replayCount: "desc" }, { updatedAt: "desc" }],
      take: 100,
    }),
    prisma.dispute.findMany({
      where: {
        status: { in: ACTIVE_DISPUTE_STATES },
        evidenceWindowEndsAt: { gt: now, lte: approaching },
      },
      select: {
        reference: true,
        title: true,
        status: true,
        priority: true,
        amountFrozenCents: true,
        evidenceWindowEndsAt: true,
        escrow: { select: { reference: true, title: true } },
      },
      orderBy: { evidenceWindowEndsAt: "asc" },
      take: 100,
    }),
  ]);
  const workerStale = !worker?.lastSuccessAt || now.getTime() - worker.lastSuccessAt.getTime() > 120_000;
  const alerts = [
    ...(workerStale ? ["Operational recovery worker has not completed successfully within two minutes"] : []),
    ...(failedOutbox ? [`${failedOutbox} failed invitation outbox event(s)`] : []),
    ...(failedJobs ? [`${failedJobs} failed operational job(s)`] : []),
    ...(agedEscrows ? [`${agedEscrows} active escrow(s) older than seven days`] : []),
    ...(disputesApproaching ? [`${disputesApproaching} dispute evidence deadline(s) within two days`] : []),
    ...(latestReconciliation?.status === "exception" ? [`${latestReconciliation.exceptionCount} reconciliation exception(s)`] : []),
  ];
  return {
    status: alerts.length > 0 ? "attention" : "healthy",
    counts: {
      failedOutbox,
      failedJobs,
      agedEscrows,
      duplicateCommandAttempts: duplicateCommands._sum.replayCount ?? 0,
      disputesApproaching,
    },
    latestReconciliation,
    worker: {
      status: workerStale ? "stale" : "healthy",
      lastStartedAt: worker?.lastStartedAt ?? null,
      lastCompletedAt: worker?.lastCompletedAt ?? null,
      lastSuccessAt: worker?.lastSuccessAt ?? null,
      lastError: worker?.lastError ?? null,
    },
    details: {
      failedOutbox: failedOutboxDetails,
      failedJobs: failedJobDetails,
      agedEscrows: agedEscrowDetails,
      duplicateCommands: duplicateCommandDetails,
      disputesApproaching: disputeDetails,
    },
    alerts,
  };
}

export async function retryOperationalJob(
  prisma: PrismaClient,
  operatorId: string,
  jobId: number,
  idempotencyKey: string,
) {
  return executeIdempotentCommand(prisma, {
    userId: operatorId,
    key: idempotencyKey,
    command: "support_retry_operational_job",
    payload: { jobId },
  }, async (tx) => {
    const job = await tx.operationalJob.findUnique({ where: { id: jobId } });
    if (!job || job.status !== "failed") throw new AppError("Only a failed operational job can be retried.", 409);
    await tx.operationalJob.update({
      where: { id: job.id },
      data: { status: "pending", runAt: new Date(), lockedAt: null, lastError: null, attemptCount: 0 },
    });
    await recordAuditEvent(tx, {
      actorId: operatorId,
      actorType: "support",
      action: "operational_job.retry_requested",
      entityType: "operational_job",
      entityId: String(job.id),
      outcome: "queued",
    });
    return { success: true, jobId: job.id, status: "pending" };
  });
}

export async function retryInvitationOutboxEvent(
  prisma: PrismaClient,
  operatorId: string,
  eventId: number,
  idempotencyKey: string,
) {
  return executeIdempotentCommand(prisma, {
    userId: operatorId,
    key: idempotencyKey,
    command: "support_retry_invitation_outbox",
    payload: { eventId },
  }, async (tx) => {
    const event = await tx.outboxEvent.findUnique({
      where: { id: eventId },
      include: { invitationDelivery: true },
    });
    if (!event || event.status !== "failed") throw new AppError("Only a failed invitation event can be retried.", 409);
    if (event.invitationDelivery.acceptedAt || event.invitationDelivery.supersededAt) {
      throw new AppError("This invitation is no longer active.", 409);
    }
    await tx.outboxEvent.update({
      where: { id: event.id },
      data: { status: "pending", attemptCount: 0, nextAttemptAt: new Date(), lastError: null },
    });
    await tx.invitationDelivery.update({
      where: { id: event.invitationDeliveryId },
      data: { status: "queued", attemptCount: 0, nextAttemptAt: new Date(), failureReason: null },
    });
    await recordAuditEvent(tx, {
      escrowId: event.invitationDelivery.escrowId,
      actorId: operatorId,
      actorType: "support",
      action: "invitation.retry_requested",
      entityType: "outbox_event",
      entityId: String(event.id),
      outcome: "queued",
    });
    return { success: true, eventId: event.id, status: "pending" };
  });
}

export async function supportExtendInvitation(
  prisma: PrismaClient,
  operatorId: string,
  deliveryId: number,
  days: number,
  idempotencyKey: string,
) {
  return executeIdempotentCommand(prisma, {
    userId: operatorId,
    key: idempotencyKey,
    command: "support_extend_invitation",
    payload: { deliveryId, days },
  }, async (tx) => {
    const delivery = await extendInvitationDelivery(tx, deliveryId, days);
    await recordAuditEvent(tx, {
      escrowId: delivery.escrowId,
      actorId: operatorId,
      actorType: "support",
      action: "invitation.extended",
      entityType: "invitation_delivery",
      entityId: String(delivery.id),
      outcome: "completed",
      metadata: { days, expiresAt: delivery.expiresAt.toISOString() },
    });
    return { success: true, deliveryId: delivery.id, expiresAt: delivery.expiresAt.toISOString() };
  });
}

export async function getEscrowAuditTrail(prisma: PrismaClient, userId: string, reference: string, support = false) {
  const escrow = await prisma.escrow.findUnique({
    where: { reference },
    include: {
      ledgerEntries: true,
      milestones: { include: { submissions: { include: { review: true } } } },
      disputes: { include: { evidenceSubmissions: true, allocations: true } },
      cancellationRequests: true,
      auditEvents: true,
    },
  });
  if (!escrow) throw new AppError("Escrow not found.", 404);
  if (!support && escrow.buyerId !== userId && escrow.sellerId !== userId && escrow.ownerId !== userId) {
    throw new AppError("You do not have access to this escrow audit trail.", 403);
  }
  const events: Array<Record<string, unknown> & { at: string }> = [
    ...escrow.ledgerEntries.map((entry) => ({
      at: entry.createdAt.toISOString(),
      type: "ledger",
      action: entry.movementType,
      amountCents: entry.amountCents,
      actorId: entry.actorId,
      sourceCommand: entry.sourceCommand,
    })),
    ...escrow.milestones.flatMap((milestone) => milestone.submissions.flatMap((submission) => [
      { at: submission.submittedAt.toISOString(), type: "milestone_submission", action: "submitted", entityId: String(milestone.id), actorId: submission.submitterId },
      ...(submission.review ? [{ at: submission.review.reviewedAt.toISOString(), type: "milestone_review", action: submission.review.decision, entityId: String(milestone.id), actorId: submission.review.reviewerId }] : []),
    ])),
    ...escrow.disputes.flatMap((dispute) => [
      { at: dispute.createdAt.toISOString(), type: "dispute", action: "opened", entityId: dispute.reference, actorId: dispute.openedById },
      ...dispute.evidenceSubmissions.map((evidence) => ({ at: evidence.submittedAt.toISOString(), type: "dispute_evidence", action: "submitted", entityId: dispute.reference, actorId: evidence.submitterId })),
      ...dispute.allocations.map((allocation) => ({ at: allocation.createdAt.toISOString(), type: "dispute_allocation", action: allocation.recipient, entityId: dispute.reference, amountCents: allocation.amountCents })),
    ]),
    ...escrow.cancellationRequests.map((request) => ({ at: request.requestedAt.toISOString(), type: "cancellation", action: request.mode, entityId: request.reference, actorId: request.requestedById, status: request.status })),
    ...escrow.auditEvents.map((event) => ({ at: event.createdAt.toISOString(), type: "audit", action: event.action, entityId: event.entityId, actorId: event.actorId, outcome: event.outcome, metadata: event.metadata })),
  ];
  return { escrowId: escrow.reference, events: events.sort((left, right) => left.at.localeCompare(right.at)) };
}
