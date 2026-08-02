import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import path from "path";
import type { FastifyInstance } from "fastify";
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { PrismaClient } from "@prisma/client";
import { reconcileEvidenceProvenance } from "../services/evidenceProvenanceService";
import { reconcileEscrowLedger } from "../services/moneyIntegrityService";
import { processMilestoneReviewDeadlines } from "../services/milestoneReviewService";

let server: FastifyInstance;
let token: string;
let counterpartyToken: string;
let schemaName: string;
const defaultPassword = "password123";
const creatorSignature = "data:image/png;base64,Y3JlYXRvcg==";
const counterpartySignature = "data:image/png;base64,Y291bnRlcnBhcnR5";
let createdEscrowReference: string;
let createdMilestoneId: number;
let secondMilestoneEscrowReference: string;
let rejectedMilestoneId: number;
let phaseFourDisputeReference: string;
let phaseFourCancellationReference: string;
let governedCancellationReference: string;
let invitedSignupEscrowReference: string;
let invitedCounterpartyToken: string;
let proofStorageDir: string;
let phaseFourDisputeExhibitId: string;
let phaseFourLegacyDisputeExhibitId: string;
let phaseFourLegacyMilestoneExhibitId: string;
const phaseFourDisputeEvidenceFileName = "seller-delivery-notes.txt";
const phaseFourLegacyDisputeFileName = "historic-dispute-reference.txt";
const phaseFourLegacyMilestoneFileName = "historic-milestone-reference.txt";
const phaseFourDisputeEvidenceBytes = Buffer.from(
  "Seller delivery notes retained as a managed arbitration exhibit.\n",
  "utf8",
);
const phaseFourDisputeEvidenceSha256 = createHash("sha256")
  .update(phaseFourDisputeEvidenceBytes)
  .digest("hex");
const sentEmails: Array<{ from?: string; to?: string; subject?: string; html?: string; text?: string }> = [];

beforeAll(async () => {
  schemaName = `vitest_${randomUUID().replaceAll("-", "")}`;
  proofStorageDir = path.join(os.tmpdir(), `myescrow-proofs-${schemaName}`);
  const databaseUrl = new URL(
    process.env.DATABASE_URL ?? "postgresql://myescrow:myescrow@localhost:5432/myescrow",
  );
  databaseUrl.searchParams.set("schema", schemaName);
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.JWT_SECRET = "test-secret";
  process.env.AUTH_SESSION_TTL_SECONDS = "28800";
  process.env.PORT = "0";
  process.env.NODE_ENV = "test";
  process.env.RESEND_API_KEY = "test-resend-key";
  process.env.MILESTONE_PROOF_STORAGE_DIR = proofStorageDir;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    sentEmails.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({ id: `email-${sentEmails.length}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
  const projectRoot = path.resolve(__dirname, "../..");
  execSync("npx prisma migrate deploy", { cwd: projectRoot, stdio: "inherit" });
  execSync("npx prisma db seed", { cwd: projectRoot, stdio: "inherit" });
  const module = await import("../server");
  server = await module.buildServer();
  await server.ready();
});

afterAll(async () => {
  if (server) {
    await server.close();
  }
  if (schemaName) {
    try {
      const prisma = new PrismaClient();
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await prisma.$disconnect();
    } catch (error) {
      console.warn("Failed to drop test schema", error);
    }
  }
  vi.unstubAllGlobals();
  if (proofStorageDir) {
    await rm(proofStorageDir, { recursive: true, force: true });
  }
  delete process.env.RESEND_API_KEY;
  delete process.env.MILESTONE_PROOF_STORAGE_DIR;
});

describe("MyEscrow API", () => {
  it("reports its build and deployment capabilities", async () => {
    const response = await server.inject({ method: "GET", url: "/version" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      buildSha: process.env.APP_BUILD_SHA ?? "development",
      capabilities: [
        "milestone_funding",
        "staged_funding_amounts",
        "agreement_funding_plan",
        "escrow_chat",
        "arbitration_reports",
        "administrative_cancellation_review",
      ],
    });
  });

  it("logs in with the seeded account", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "scott@example.com", password: defaultPassword },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user.email).toBe("scott@example.com");
    token = body.token;
    expect(token).toBeDefined();
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const payload = server.jwt.decode<{ iat: number; exp: number; portal: string }>(token);
    expect(payload).not.toBeNull();
    if (!payload) throw new Error("Expected a decodable session token");
    expect(payload.exp - payload.iat).toBe(28_800);
    expect(payload.portal).toBe("customer");
  });

  it("issues a password reset code and accepts a new password", async () => {
    const forgotResponse = await server.inject({
      method: "POST",
      url: "/api/auth/forgot-password",
      payload: { email: "scott@example.com" },
    });
    expect(forgotResponse.statusCode).toBe(200);
    const forgotBody = forgotResponse.json();
    expect(forgotBody.accepted).toBe(true);
    expect(forgotBody.debugCode).toBeDefined();

    const resetResponse = await server.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: {
        email: "scott@example.com",
        code: forgotBody.debugCode,
        password: "BetterPassword123!",
      },
    });
    expect(resetResponse.statusCode).toBe(200);
    expect(resetResponse.json().success).toBe(true);

    const loginResponse = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "scott@example.com", password: "BetterPassword123!" },
    });
    expect(loginResponse.statusCode).toBe(200);
  });

  it("logs in with the counterparty account", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nora@example.com", password: defaultPassword },
    });
    expect(response.statusCode).toBe(200);
    counterpartyToken = response.json().token;
    expect(counterpartyToken).toBeDefined();
  });

  it("keeps an idempotent escrow conversation available to both parties in every lifecycle state", async () => {
    const firstPayload = { body: "Can we confirm the acceptance criteria before work starts?" };
    const firstSend = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/PO-1423/messages",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "chat-po-1423-first",
      },
      payload: firstPayload,
    });
    expect(firstSend.statusCode).toBe(201);
    expect(firstSend.json().message).toEqual(expect.objectContaining({
      body: firstPayload.body,
      sender: expect.objectContaining({ name: "Scott", role: "buyer" }),
    }));

    const replay = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/PO-1423/messages",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "chat-po-1423-first",
      },
      payload: firstPayload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(firstSend.json());
    expect(await server.prisma.escrowMessage.count({
      where: { escrow: { reference: "PO-1423" } },
    })).toBe(1);

    const counterpartyView = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows/PO-1423/messages",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    expect(counterpartyView.statusCode).toBe(200);
    expect(counterpartyView.json()).toEqual(expect.objectContaining({
      escrowId: "PO-1423",
      canSend: true,
      participants: [
        expect.objectContaining({ name: "Scott", role: "buyer" }),
        expect.objectContaining({ name: "Nora Studio", role: "seller" }),
      ],
      messages: [expect.objectContaining({ body: firstPayload.body })],
    }));

    await server.prisma.escrow.update({
      where: { reference: "PO-1423" },
      data: { lifecycleStatus: "completed" },
    });
    try {
      const terminalStateSend = await server.inject({
        method: "POST",
        url: "/api/dashboard/escrows/PO-1423/messages",
        headers: {
          Authorization: `Bearer ${counterpartyToken}`,
          "Idempotency-Key": "chat-po-1423-complete",
        },
        payload: { body: "Thanks, I have saved the final handoff details here." },
      });
      expect(terminalStateSend.statusCode).toBe(201);
    } finally {
      await server.prisma.escrow.update({
        where: { reference: "PO-1423" },
        data: { lifecycleStatus: "pending_approval" },
      });
    }

    await server.prisma.user.create({
      data: {
        id: "chat-outsider",
        name: "Outside User",
        email: "outside-chat@example.com",
        passwordHash: "not-used",
        emailVerified: true,
      },
    });
    const outsiderToken = server.jwt.sign({
      userId: "chat-outsider",
      email: "outside-chat@example.com",
    });
    const outsiderView = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows/PO-1423/messages",
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    expect(outsiderView.statusCode).toBe(403);
  });

  it("changes the authenticated user's password", async () => {
    const unauthorizedResponse = await server.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: defaultPassword, newPassword: "StrongerPassword456!" },
    });
    expect(unauthorizedResponse.statusCode).toBe(401);

    const incorrectResponse = await server.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { currentPassword: "not-the-password", newPassword: "StrongerPassword456!" },
    });
    expect(incorrectResponse.statusCode).toBe(401);
    expect(incorrectResponse.json().error).toBe("Current password is incorrect.");

    const weakResponse = await server.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { currentPassword: defaultPassword, newPassword: "too-weak" },
    });
    expect(weakResponse.statusCode).toBe(400);

    const response = await server.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { currentPassword: defaultPassword, newPassword: "StrongerPassword456!" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);

    const oldPasswordLogin = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nora@example.com", password: defaultPassword },
    });
    expect(oldPasswordLogin.statusCode).toBe(401);

    const newPasswordLogin = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nora@example.com", password: "StrongerPassword456!" },
    });
    expect(newPasswordLogin.statusCode).toBe(200);
  });

  it("returns dashboard overview", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard/overview",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summaryMetrics).toHaveLength(4);
    expect(body.activeEscrows.length).toBeGreaterThan(0);
  });

  it("returns real notification creation timestamps", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.notifications.length).toBeGreaterThan(0);
    expect(body.notifications[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("persists dismissed notifications for the signed-in user", async () => {
    const beforeResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications",
      headers: { Authorization: `Bearer ${token}` },
    });
    const notificationId = beforeResponse.json().notifications[0].id;

    const dismissResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/notifications/${notificationId}/dismiss`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dismissResponse.statusCode).toBe(200);
    expect(dismissResponse.json().success).toBe(true);

    const afterResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(afterResponse.json().notifications).not.toContainEqual(
      expect.objectContaining({ id: notificationId }),
    );

    const historyResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications?history=true",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(historyResponse.json().notifications).toContainEqual(
      expect.objectContaining({ id: notificationId }),
    );
  });

  it("creates a new escrow", async () => {
    const emailsBefore = sentEmails.length;
    const payload = {
      title: "New project escrow",
      counterpartyEmail: "nora@example.com",
      creatorRole: "buyer",
      creatorParty: {
        type: "business",
        business: {
          legalName: "Scott Holdings Inc.",
          representativeTitle: "Director",
        },
      },
      amount: 1500,
      fundingMode: "full",
      category: "Construction",
      signatureDataUrl: creatorSignature,
      milestones: [
        { title: "Deposit", amount: 500, description: "Kickoff payment", deadline: "2026-08-01T00:00:00.000Z" },
        { title: "Final handoff", amount: 1000, description: "Final delivery" },
      ],
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "create-main-escrow" },
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().counterpart).toBe("Nora Studio");
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.reference).toMatch(/^PO-/);
    createdEscrowReference = body.reference;
    const replay = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "create-main-escrow" },
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(body);
    expect(await server.prisma.escrow.count({ where: { reference: createdEscrowReference } })).toBe(1);
    const persistedEscrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: createdEscrowReference },
      include: {
        agreementVersions: { include: { signatures: true } },
        invitationDeliveries: true,
      },
    });
    expect(persistedEscrow.agreementVersions).toHaveLength(1);
    expect(persistedEscrow.agreementVersions[0]).toEqual(expect.objectContaining({
      versionNumber: 1,
      status: "current",
      fundingMode: "full",
    }));
    expect(persistedEscrow.fundingMode).toBe("full");
    expect(persistedEscrow.agreementVersions[0]?.signatures).toHaveLength(1);
    expect(persistedEscrow.invitationDeliveries).toHaveLength(1);
    expect(persistedEscrow.invitationDeliveries[0]?.status).toBe("delivered");
    expect(await server.prisma.outboxEvent.count({
      where: { invitationDelivery: { escrowId: persistedEscrow.id } },
    })).toBe(1);
    expect(sentEmails).toHaveLength(emailsBefore + 1);
    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(escrowsResponse.json().fundingPlanSelectionSupported).toBe(true);
    const createdEscrow = escrowsResponse.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(createdEscrow.buyer).toEqual(expect.objectContaining({
      name: "Scott Holdings Inc.",
      partyType: "business",
      representativeName: "Scott",
      representativeTitle: "Director",
    }));
    const businessProfileResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/business-profile",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(businessProfileResponse.statusCode).toBe(200);
    expect(businessProfileResponse.json().businessProfile).toEqual({
      legalName: "Scott Holdings Inc.",
      representativeTitle: "Director",
    });
  });

  it("keeps a failed invitation visible and lets the creator recover it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }));
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "create-provider-outage" },
      payload: {
        title: "Invitation outage escrow",
        counterpartyEmail: "outage.recipient@example.com",
        creatorRole: "buyer",
        amount: 425,
        signatureDataUrl: creatorSignature,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const reference = createResponse.json().reference;

    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const failedEscrow = escrowsResponse.json().escrows.find((item: any) => item.id === reference);
    expect(failedEscrow).toEqual(expect.objectContaining({
      lifecycleStatus: "pending_counterparty_signup",
      invitation: expect.objectContaining({ status: "failed", attemptCount: 1 }),
    }));

    const failedDelivery = await server.prisma.invitationDelivery.findFirstOrThrow({
      where: { escrow: { reference } },
      orderBy: { createdAt: "desc" },
    });
    const failedEvent = await server.prisma.outboxEvent.findFirstOrThrow({
      where: { invitationDeliveryId: failedDelivery.id },
    });
    expect(failedEvent.status).toBe("pending");
    expect(failedEvent.attemptCount).toBe(1);
    expect(failedEvent.nextAttemptAt).not.toBeNull();

    const extendResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/invitation/extend`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { days: 7 },
    });
    expect(extendResponse.statusCode).toBe(200);
    expect(new Date(extendResponse.json().expiresAt).getTime()).toBeGreaterThan(failedDelivery.expiresAt.getTime());

    const resendResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/invitation/resend`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resendResponse.statusCode).toBe(200);
    expect(await server.prisma.invitationDelivery.count({ where: { escrow: { reference } } })).toBe(2);
    expect((await server.prisma.outboxEvent.findUniqueOrThrow({ where: { id: failedEvent.id } })).status).toBe("cancelled");
    const recoveredDelivery = await server.prisma.invitationDelivery.findFirstOrThrow({
      where: { escrow: { reference } },
      orderBy: { createdAt: "desc" },
    });
    expect(recoveredDelivery.status).toBe("delivered");

    const correctionResponse = await server.inject({
      method: "PATCH",
      url: `/api/dashboard/escrows/${reference}`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        title: "Invitation outage escrow",
        counterpartyEmail: "corrected.recipient@example.com",
        amount: 425,
      },
    });
    expect(correctionResponse.statusCode).toBe(200);
    const correctedEscrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference },
      include: {
        agreementVersions: { orderBy: { versionNumber: "asc" }, include: { signatures: true } },
        invitationDeliveries: { orderBy: { createdAt: "asc" } },
      },
    });
    expect(correctedEscrow.agreementVersions).toHaveLength(2);
    expect(correctedEscrow.agreementVersions[0]?.status).toBe("superseded");
    expect(correctedEscrow.agreementVersions[1]?.signatures).toHaveLength(0);
    expect(correctedEscrow.invitationDeliveries.at(-2)?.status).toBe("corrected");
    expect(correctedEscrow.invitationDeliveries.at(-1)).toEqual(expect.objectContaining({
      recipient: "corrected.recipient@example.com",
      status: "delivered",
    }));

    const resignResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/agreement/sign`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { signatureDataUrl: creatorSignature },
    });
    expect(resignResponse.statusCode).toBe(200);
  });

  it("supports agreement-level change requests with added milestones", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "create-agreement-route" },
      payload: {
        title: "Agreement route escrow",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        amount: 1500,
        signatureDataUrl: creatorSignature,
        milestones: [
          { title: "Discovery", amount: 750, description: "Initial review" },
          { title: "Delivery", amount: 750, description: "Final package" },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const reference = createResponse.json().reference;

    const counterpartyEscrows = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    const escrow = counterpartyEscrows.json().escrows.find((item: any) => item.id === reference);
    expect(escrow).toBeDefined();

    const requestResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/agreement-changes`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: {
        milestones: [
          {
            milestoneId: escrow.milestones[0].id,
            title: "Discovery",
            description: "Initial review",
            amount: 500,
          },
          {
            milestoneId: escrow.milestones[1].id,
            title: "Delivery",
            description: "Final package",
            amount: 700,
          },
          {
            title: "Support",
            description: "Post-launch support",
            amount: 300,
          },
        ],
        note: "Please add a support milestone.",
      },
    });

    expect(requestResponse.statusCode).toBe(200);
    const ownerEscrows = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const changedEscrow = ownerEscrows.json().escrows.find((item: any) => item.id === reference);
    expect(changedEscrow.lifecycleStatus).toBe("changes_requested");
    expect(changedEscrow.milestones).toContainEqual(
      expect.objectContaining({
        title: "Support",
        requestedAmount: "$300.00",
        changeRequestNote: "Please add a support milestone.",
      }),
    );
  });

  const agreementFundingGateScenarios = [
    {
      name: "existing milestone terms change",
      title: "Milestone edit approval gate",
      expectedMilestone: { title: "Design revision", amount: "$650.00" },
      kind: "edit",
    },
    {
      name: "new milestone is added",
      title: "Milestone addition approval gate",
      expectedMilestone: { title: "Launch support", amount: "$300.00" },
      kind: "add",
    },
  ] as const;

  it.each(agreementFundingGateScenarios)(
    "requires creator-reviewed agreement changes to be approved before funding when $name",
    async (scenario) => {
      const createResponse = await server.inject({
        method: "POST",
        url: "/api/dashboard/escrows/create",
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": `create-agreement-${scenario.name}` },
        payload: {
          title: scenario.title,
          counterpartyEmail: "nora@example.com",
          creatorRole: "buyer",
          amount: 1500,
          signatureDataUrl: creatorSignature,
          milestones: [
            { title: "Design", amount: 500 },
            { title: "Build", amount: 1000 },
          ],
        },
      });
      expect(createResponse.statusCode).toBe(201);
      const reference = createResponse.json().reference;

      const counterpartyEscrows = await server.inject({
        method: "GET",
        url: "/api/dashboard/escrows",
        headers: { Authorization: `Bearer ${counterpartyToken}` },
      });
      const counterpartyEscrow = counterpartyEscrows.json().escrows.find((item: any) => item.id === reference);
      const originalMilestones = counterpartyEscrow.milestones as Array<{ id: number }>;
      const firstMilestoneId = originalMilestones[0]?.id;
      const secondMilestoneId = originalMilestones[1]?.id;
      if (!firstMilestoneId || !secondMilestoneId) {
        throw new Error("Expected two original milestones in funding gate scenario.");
      }
      const requestedMilestones = scenario.kind === "edit"
        ? [
            {
              milestoneId: firstMilestoneId,
              title: "Design revision",
              amount: 650,
            },
            {
              milestoneId: secondMilestoneId,
              title: "Build revision",
              amount: 850,
            },
          ]
        : [
            {
              milestoneId: firstMilestoneId,
              title: "Design",
              amount: 500,
            },
            {
              milestoneId: secondMilestoneId,
              title: "Build",
              amount: 700,
            },
            {
              title: "Launch support",
              amount: 300,
            },
          ];

      const requestResponse = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/request-changes`,
        headers: { Authorization: `Bearer ${counterpartyToken}` },
        payload: {
          milestones: requestedMilestones,
        },
      });
      expect(requestResponse.statusCode).toBe(200);

      const acceptResponse = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/apply-changes`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { decision: "accept" },
      });
      expect(acceptResponse.statusCode).toBe(200);

      const pendingApprovalEscrows = await server.inject({
        method: "GET",
        url: "/api/dashboard/escrows",
        headers: { Authorization: `Bearer ${token}` },
      });
      const pendingApprovalEscrow = pendingApprovalEscrows.json().escrows.find((item: any) => item.id === reference);
      expect(pendingApprovalEscrow.lifecycleStatus).toBe("creator_signature_required");
      expect(pendingApprovalEscrow.counterpartyApproved).toBe(false);
      expect(pendingApprovalEscrow.agreement).toEqual(expect.objectContaining({
        version: 2,
        status: "current",
        creatorSigned: false,
        counterpartySigned: false,
      }));
      const agreementVersions = await server.prisma.agreementVersion.findMany({
        where: { escrow: { reference } },
        orderBy: { versionNumber: "asc" },
        include: { signatures: true },
      });
      expect(agreementVersions).toHaveLength(2);
      expect(agreementVersions[0]).toEqual(expect.objectContaining({ status: "superseded" }));
      expect(agreementVersions[0]?.signatures).toHaveLength(1);
      expect(agreementVersions[1]).toEqual(expect.objectContaining({ status: "current" }));
      expect(agreementVersions[1]?.signatures).toHaveLength(0);
      expect(pendingApprovalEscrow.milestones).toContainEqual(
        expect.objectContaining({
          title: scenario.expectedMilestone.title,
          amount: scenario.expectedMilestone.amount,
        }),
      );

      const fundBeforeApprovalResponse = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/fund`,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": `fund-before-${reference}` },
      });
      expect(fundBeforeApprovalResponse.statusCode).toBe(400);
      expect(fundBeforeApprovalResponse.json().error).toBe("This escrow is not ready for funding.");

      const creatorSignResponse = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/agreement/sign`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { signatureDataUrl: creatorSignature },
      });
      expect(creatorSignResponse.statusCode).toBe(200);

      const resignedEscrows = await server.inject({
        method: "GET",
        url: "/api/dashboard/escrows",
        headers: { Authorization: `Bearer ${token}` },
      });
      const resignedEscrow = resignedEscrows.json().escrows.find((item: any) => item.id === reference);
      expect(resignedEscrow.lifecycleStatus).toBe("pending_approval");
      expect(resignedEscrow.agreement).toEqual(expect.objectContaining({
        version: 2,
        creatorSigned: true,
        counterpartySigned: false,
      }));

      const approveResponse = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/approve`,
        headers: { Authorization: `Bearer ${counterpartyToken}` },
        payload: { signatureDataUrl: counterpartySignature },
      });
      expect(approveResponse.statusCode).toBe(200);

      const fundAfterApprovalResponse = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/fund`,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": `fund-after-${reference}` },
      });
      expect(fundAfterApprovalResponse.statusCode).toBe(200);
      expect(fundAfterApprovalResponse.json().success).toBe(true);
    },
  );

  it("supports milestone change requests before escrow approval", async () => {
    const counterpartyEscrows = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    const escrow = counterpartyEscrows.json().escrows.find((item: any) => item.id === createdEscrowReference);
    const milestoneId = escrow.milestones[0].id;
    expect(escrow.milestones[0].deadline).toBe("2026-08-01T00:00:00.000Z");

    sentEmails.length = 0;
    const requestResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${milestoneId}/request-changes`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: {
        title: "Revised deposit wording",
        description: "Updated kickoff scope",
        amount: 600,
        deadline: "2026-08-15T00:00:00.000Z",
        note: "Please allow two more weeks.",
      },
    });
    expect(requestResponse.statusCode).toBe(200);
    expect(requestResponse.json().emailNotification).toBe("sent");
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toEqual(
      expect.objectContaining({
        to: "scott@example.com",
        subject: expect.stringContaining(`requested changes to ${createdEscrowReference}`),
        text: expect.stringContaining("Please allow two more weeks."),
      }),
    );

    const ownerBeforeApply = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const requestedEscrow = ownerBeforeApply.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(requestedEscrow.lifecycleStatus).toBe("changes_requested");
    expect(requestedEscrow.milestones[0].requestedTitle).toBe("Revised deposit wording");

    const secondMilestone = requestedEscrow.milestones[1];
    const secondRequestWhileFirstPending = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${secondMilestone.id}/request-changes`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { title: "Changed handoff", amount: 900, note: "Reduce this payment." },
    });
    expect(secondRequestWhileFirstPending.statusCode).toBe(200);

    const ownerWithTwoRequestsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const ownerWithTwoRequests = ownerWithTwoRequestsResponse.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(ownerWithTwoRequests.lifecycleStatus).toBe("changes_requested");
    expect(ownerWithTwoRequests.milestones[0].requestedTitle).toBe("Revised deposit wording");
    expect(ownerWithTwoRequests.milestones[1].requestedTitle).toBe("Changed handoff");

    const ownerNotificationsWithTwoRequests = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications",
      headers: { Authorization: `Bearer ${token}` },
    });
    const changeRequestNotifications = ownerNotificationsWithTwoRequests
      .json()
      .notifications.filter((notification: any) => notification.label === "Milestone changes requested");
    expect(changeRequestNotifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ detail: expect.stringContaining("Deposit") }),
        expect.objectContaining({ detail: expect.stringContaining("Final handoff") }),
      ]),
    );

    const applyResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${milestoneId}/apply-changes`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        decision: "accept",
        title: "Creator-reviewed deposit wording",
        description: "Creator-adjusted kickoff scope",
        amount: 625,
        deadline: "2026-08-20T00:00:00.000Z",
      },
    });
    expect(applyResponse.statusCode).toBe(200);

    const counterpartyAfterApply = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    const revisedEscrow = counterpartyAfterApply.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(revisedEscrow.lifecycleStatus).toBe("changes_requested");
    expect(revisedEscrow.amount).toBe("$1,625.00");
    expect(revisedEscrow.milestones[0]).toEqual(
      expect.objectContaining({
        title: "Creator-reviewed deposit wording",
        amount: "$625.00",
        deadline: "2026-08-20T00:00:00.000Z",
      }),
    );
    expect(revisedEscrow.milestones[0].requestedTitle).toBeUndefined();
    expect(revisedEscrow.milestones[1].requestedTitle).toBe("Changed handoff");

    const ownerNotificationsAfterFirstApply = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications",
      headers: { Authorization: `Bearer ${token}` },
    });
    const remainingChangeRequestNotifications = ownerNotificationsAfterFirstApply
      .json()
      .notifications.filter((notification: any) => notification.label === "Milestone changes requested");
    expect(remainingChangeRequestNotifications).not.toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining("Deposit") }),
    );
    expect(remainingChangeRequestNotifications).toContainEqual(
      expect.objectContaining({ detail: expect.stringContaining("Final handoff") }),
    );

    const retainedMilestone = revisedEscrow.milestones[1];
    const rejectResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${retainedMilestone.id}/apply-changes`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { decision: "reject" },
    });
    expect(rejectResponse.statusCode).toBe(200);

    const afterRejectResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const afterReject = afterRejectResponse.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(afterReject.lifecycleStatus).toBe("pending_approval");
    expect(afterReject.amount).toBe("$1,625.00");
    expect(afterReject.milestones[1]).toEqual(
      expect.objectContaining({ title: "Final handoff", amount: "$1,000.00" }),
    );
    expect(afterReject.milestones[1].requestedTitle).toBeUndefined();

    const ownerNotificationsAfterSecondReview = await server.inject({
      method: "GET",
      url: "/api/dashboard/notifications",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ownerNotificationsAfterSecondReview.json().notifications).not.toContainEqual(
      expect.objectContaining({
        label: "Milestone changes requested",
        detail: expect.stringContaining("Final handoff"),
      }),
    );
  });

  it("creates an escrow for a counterparty who has not signed up yet", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "create-invite-first" },
      payload: {
        title: "Invite-first escrow",
        counterpartyEmail: "jamie.contractor@example.com",
        creatorRole: "buyer",
        amount: 750,
        signatureDataUrl: creatorSignature,
      },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.invitationStatus).toBe("signup_required");
    invitedSignupEscrowReference = body.reference;

    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const invitedEscrow = escrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === invitedSignupEscrowReference);
    expect(invitedEscrow.lifecycleStatus).toBe("pending_counterparty_signup");
    expect(invitedEscrow.stage).toBe("Invitation pending");
    expect(invitedEscrow.counterpart).toBe("jamie.contractor@example.com");

    const pendingChat = await server.inject({
      method: "GET",
      url: `/api/dashboard/escrows/${invitedSignupEscrowReference}/messages`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(pendingChat.statusCode).toBe(200);
    expect(pendingChat.json()).toEqual(expect.objectContaining({
      canSend: false,
      messages: [],
      unavailableReason: expect.stringContaining("counterparty joins"),
    }));

    const prematureSend = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${invitedSignupEscrowReference}/messages`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "chat-before-counterparty",
      },
      payload: { body: "This should wait until the invited party has an account." },
    });
    expect(prematureSend.statusCode).toBe(409);
  });

  it("claims the pending escrow after the invited counterparty signs up and verifies", async () => {
    const signupResponse = await server.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        name: "Jamie Contractor",
        email: "jamie.contractor@example.com",
        password: "InviteFlowPass123!",
        partyType: "business",
        business: {
          legalName: "Jamie Contractor LLC",
          representativeTitle: "Owner",
        },
      },
    });
    expect(signupResponse.statusCode).toBe(201);
    const signupBody = signupResponse.json();
    expect(signupBody.verificationRequired).toBe(true);
    expect(signupBody.debugCode).toBeDefined();

    const verifyResponse = await server.inject({
      method: "POST",
      url: "/api/auth/verify-email",
      payload: {
        email: "jamie.contractor@example.com",
        code: signupBody.debugCode,
      },
    });
    expect(verifyResponse.statusCode).toBe(200);
    invitedCounterpartyToken = verifyResponse.json().token;
    expect(invitedCounterpartyToken).toBeDefined();

    const businessProfileResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/business-profile",
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    expect(businessProfileResponse.statusCode).toBe(200);
    expect(businessProfileResponse.json().businessProfile).toEqual({
      legalName: "Jamie Contractor LLC",
      representativeTitle: "Owner",
    });

    const walletResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/wallet/transactions",
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    expect(walletResponse.statusCode).toBe(200);
    expect(walletResponse.json().transactions).toEqual([]);

    const overviewResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/overview",
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    expect(overviewResponse.statusCode).toBe(200);
    expect(overviewResponse.json().walletBalance).toBe("$0.00");

    const ownerEscrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const ownerEscrow = ownerEscrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === invitedSignupEscrowReference);
    expect(ownerEscrow.lifecycleStatus).toBe("pending_approval");
    expect(ownerEscrow.counterpart).toBe("Jamie Contractor");

    const invitedEscrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    const invitedEscrow = invitedEscrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === invitedSignupEscrowReference);
    expect(invitedEscrow).toBeDefined();
    expect(invitedEscrow.lifecycleStatus).toBe("pending_approval");
  });

  it("lets the invited counterparty approve after onboarding", async () => {
    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${invitedSignupEscrowReference}/approve`,
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });

  it("approves the escrow as the counterparty", async () => {
    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: {
        signatureDataUrl: counterpartySignature,
        counterpartyParty: {
          type: "business",
          business: {
            legalName: "Nora Studio Ltd.",
            representativeTitle: "Owner",
          },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const approvedEscrow = escrowsResponse.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(approvedEscrow.seller).toEqual(expect.objectContaining({
      name: "Nora Studio Ltd.",
      partyType: "business",
      representativeName: "Nora Studio",
      representativeTitle: "Owner",
    }));
  });

  it("funds the escrow only once when duplicate requests arrive together", async () => {
    const buyerBefore = await server.prisma.user.findUniqueOrThrow({
      where: { email: "scott@example.com" },
    });
    const escrowBefore = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: createdEscrowReference },
    });
    const fundingEntriesBefore = await server.prisma.walletTransaction.count({
      where: { userId: buyerBefore.id, type: "FUND", amountCents: -escrowBefore.amountCents },
    });

    const idempotencyKey = `fund-${createdEscrowReference}`;
    const responses = await Promise.all([
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${createdEscrowReference}/fund`,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
      }),
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${createdEscrowReference}/fund`,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0].json()).toEqual(responses[1].json());

    const buyerAfter = await server.prisma.user.findUniqueOrThrow({
      where: { id: buyerBefore.id },
    });
    const fundingEntriesAfter = await server.prisma.walletTransaction.count({
      where: { userId: buyerBefore.id, type: "FUND", amountCents: -escrowBefore.amountCents },
    });
    expect(buyerAfter.walletBalanceCents).toBe(buyerBefore.walletBalanceCents - escrowBefore.amountCents);
    expect(fundingEntriesAfter).toBe(fundingEntriesBefore + 1);
    expect(await server.prisma.escrowLedgerEntry.count({
      where: { escrowId: escrowBefore.id, movementType: "fund" },
    })).toBe(1);
    const fundedView = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(fundedView.balances).toEqual({
      currency: "USD",
      fundedCents: escrowBefore.amountCents,
      heldCents: escrowBefore.amountCents,
      releasedCents: 0,
      refundedCents: 0,
      disputedCents: 0,
    });
    expect(fundedView.fundingMode).toBe("full");
  });

  it("allocates staged deposits across milestones and keeps partial milestones locked", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "create-tier-funded-escrow",
      },
      payload: {
        title: "Tier-funded project",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        creatorParty: { type: "individual" },
        amount: 300,
        fundingMode: "milestone",
        signatureDataUrl: creatorSignature,
        milestones: [
          { title: "Discovery", amount: 100 },
          { title: "Delivery", amount: 200 },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const reference = createResponse.json().reference;

    const approval = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    });
    expect(approval.statusCode).toBe(200);

    const beforeFunding = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === reference);
    const [firstMilestone, secondMilestone] = beforeFunding.milestones;
    expect(beforeFunding.fundingMode).toBe("milestone");
    expect(beforeFunding.agreement.fundingMode).toBe("milestone");

    const wrongAgreedFundingRoute = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `fund-full-against-agreement-${reference}`,
      },
    });
    expect(wrongAgreedFundingRoute.statusCode).toBe(409);
    expect(wrongAgreedFundingRoute.json().error).toContain("agreement uses staged funding");

    const skippedMilestoneFunding = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${secondMilestone.id}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `fund-tier-skip-${reference}-${secondMilestone.id}`,
      },
      payload: { amount: 250 },
    });
    expect(skippedMilestoneFunding.statusCode).toBe(409);
    expect(skippedMilestoneFunding.json().error).toContain(`starting with "${firstMilestone.title}"`);

    const fundingIdempotencyKey = `fund-tier-${reference}-${firstMilestone.id}`;
    const funding = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${firstMilestone.id}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": fundingIdempotencyKey,
      },
      payload: { amount: 250 },
    });
    expect(funding.statusCode).toBe(200);
    expect(funding.json()).toEqual(expect.objectContaining({
      milestoneId: firstMilestone.id,
      fundingStatus: "partially_funded",
      depositedCents: 25_000,
      fundedCents: 25_000,
      remainingCents: 5_000,
      allocations: [
        expect.objectContaining({
          milestoneId: firstMilestone.id,
          fundedCents: 10_000,
          addedCents: 10_000,
          fundingStatus: "funded",
        }),
        expect.objectContaining({
          milestoneId: secondMilestone.id,
          fundedCents: 15_000,
          addedCents: 15_000,
          fundingStatus: "partially_funded",
        }),
      ],
    }));
    const replayedFunding = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${firstMilestone.id}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": fundingIdempotencyKey,
      },
      payload: { amount: 250 },
    });
    expect(replayedFunding.statusCode).toBe(200);
    expect(replayedFunding.json()).toEqual(funding.json());
    expect(await server.prisma.escrowLedgerEntry.count({
      where: {
        escrowId: beforeFunding.escrowId,
        movementType: "fund",
        amountCents: 25_000,
        milestoneId: null,
      },
    })).toBe(1);

    const fundedView = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === reference);
    expect(fundedView).toEqual(expect.objectContaining({
      lifecycleStatus: "funded",
      fundingStatus: "partially_funded",
      fundingMode: "milestone",
    }));
    expect(fundedView.balances.fundedCents).toBe(25_000);
    expect(fundedView.milestones[0]).toEqual(expect.objectContaining({
      fundingStatus: "funded",
      fundedCents: 10_000,
    }));
    expect(fundedView.milestones[1]).toEqual(expect.objectContaining({
      fundingStatus: "partially_funded",
      fundedCents: 15_000,
    }));

    const unfundedSubmission = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${secondMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-unfunded-${reference}-${secondMilestone.id}`,
      },
      payload: { note: "Trying to submit before this tier is funded." },
    });
    expect(unfundedSubmission.statusCode).toBe(409);
    expect(unfundedSubmission.json().error).toContain("must fully fund this milestone");

    const unfundedProofForm = new FormData();
    unfundedProofForm.append("note", "Trying to upload proof before this tier is funded.");
    unfundedProofForm.append(
      "proofs",
      new Blob(["unfunded proof"], { type: "text/plain" }),
      "unfunded-proof.txt",
    );
    const unfundedProofRequest = new Request("http://localhost/upload", {
      method: "POST",
      body: unfundedProofForm,
    });
    const unfundedProofSubmission = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${secondMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-unfunded-proof-${reference}-${secondMilestone.id}`,
        "Content-Type": unfundedProofRequest.headers.get("Content-Type") ?? "",
      },
      payload: Buffer.from(await unfundedProofRequest.arrayBuffer()),
    });
    expect(unfundedProofSubmission.statusCode).toBe(409);
    expect(unfundedProofSubmission.json().error).toContain(
      "must fully fund this milestone before proof can be uploaded",
    );

    const remainingFunding = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${secondMilestone.id}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `fund-tier-remaining-${reference}-${secondMilestone.id}`,
      },
    });
    expect(remainingFunding.statusCode).toBe(200);
    expect(remainingFunding.json()).toEqual(expect.objectContaining({
      depositedCents: 5_000,
      fundedCents: 30_000,
      remainingCents: 0,
      fundingStatus: "funded",
    }));

    const fullyFundedView = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === reference);
    expect(fullyFundedView.milestones[1]).toEqual(expect.objectContaining({
      fundingStatus: "funded",
      fundedCents: 20_000,
    }));

    const outOfOrderProofForm = new FormData();
    outOfOrderProofForm.append("note", "Funded, but still waiting for the earlier milestone.");
    outOfOrderProofForm.append(
      "proofs",
      new Blob(["out-of-order proof"], { type: "text/plain" }),
      "out-of-order-proof.txt",
    );
    const outOfOrderProofRequest = new Request("http://localhost/upload", {
      method: "POST",
      body: outOfOrderProofForm,
    });
    const outOfOrderProofSubmission = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${secondMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-funded-proof-out-of-order-${reference}-${secondMilestone.id}`,
        "Content-Type": outOfOrderProofRequest.headers.get("Content-Type") ?? "",
      },
      payload: Buffer.from(await outOfOrderProofRequest.arrayBuffer()),
    });
    expect(outOfOrderProofSubmission.statusCode).toBe(409);
    expect(outOfOrderProofSubmission.json().error).toContain("Complete the earlier milestone");

    const outOfOrderSubmission = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/milestones/${secondMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-funded-out-of-order-${reference}-${secondMilestone.id}`,
      },
      payload: { note: "The milestone is funded, but the earlier workflow is incomplete." },
    });
    expect(outOfOrderSubmission.statusCode).toBe(409);
    expect(outOfOrderSubmission.json().error).toContain("Complete the earlier milestone");

    const fullFunding = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `fund-full-after-tier-${reference}`,
      },
    });
    expect(fullFunding.statusCode).toBe(409);
    expect(fullFunding.json().error).toContain("uses staged funding");
  });

  it("serializes competing staged deposits so they cannot overfund the escrow", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "create-concurrent-staged-escrow",
      },
      payload: {
        title: "Concurrent staged funding",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        creatorParty: { type: "individual" },
        amount: 100,
        signatureDataUrl: creatorSignature,
        milestones: [
          { title: "First half", amount: 50 },
          { title: "Second half", amount: 50 },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const reference = createResponse.json().reference;
    expect((await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    })).statusCode).toBe(200);

    const escrow = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === reference);
    const firstMilestone = escrow.milestones[0];
    const responses = await Promise.all([
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/milestones/${firstMilestone.id}/fund`,
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `concurrent-stage-a-${reference}`,
        },
        payload: { amount: 75 },
      }),
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${reference}/milestones/${firstMilestone.id}/fund`,
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `concurrent-stage-b-${reference}`,
        },
        payload: { amount: 75 },
      }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);

    const fundedEscrow = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === reference);
    expect(fundedEscrow.balances.fundedCents).toBe(7_500);
    expect(fundedEscrow.milestones).toEqual([
      expect.objectContaining({ fundingStatus: "funded", fundedCents: 5_000 }),
      expect.objectContaining({ fundingStatus: "partially_funded", fundedCents: 2_500 }),
    ]);
  });

  it("blocks legacy full release and cancellation after funding", async () => {
    const releaseResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/release`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(releaseResponse.statusCode).toBe(409);
    expect(releaseResponse.json().error).toBe(
      "Full escrow release is disabled. Approve each milestone separately.",
    );

    const cancelResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/cancel`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelResponse.statusCode).toBe(409);
    expect(cancelResponse.json().error).toBe(
      "Funded escrows cannot be cancelled until the refund workflow is available.",
    );
  });

  it("requires seller submission and enforces milestone order before buyer review", async () => {
    const escrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: createdEscrowReference },
      include: { milestones: { orderBy: { orderIndex: "asc" } } },
    });
    const firstMilestone = escrow.milestones[0];
    const secondMilestone = escrow.milestones[1];
    if (!firstMilestone || !secondMilestone) throw new Error("Expected two milestones.");

    const earlyApproval = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${firstMilestone.id}/approve`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `early-approve-${firstMilestone.id}`,
      },
    });
    expect(earlyApproval.statusCode).toBe(409);

    const outOfOrderSubmission = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${secondMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `early-submit-${secondMilestone.id}`,
      },
      payload: { note: "Second milestone is ready." },
    });
    expect(outOfOrderSubmission.statusCode).toBe(409);

    const proofContents = Buffer.from("%PDF-1.4 milestone receipt");
    const buildSubmissionRequest = () => {
      const form = new FormData();
      form.append("note", "The first milestone is complete and ready for review.");
      form.append("proofs", new Blob([proofContents], { type: "application/pdf" }), "proof.pdf");
      return new Request("http://localhost/upload", { method: "POST", body: form });
    };
    const submissionRequest = buildSubmissionRequest();
    const idempotencyKey = `submit-${firstMilestone.id}-1`;
    const submission = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${firstMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": submissionRequest.headers.get("Content-Type") ?? "",
      },
      payload: Buffer.from(await submissionRequest.arrayBuffer()),
    });
    expect(submission.statusCode).toBe(200);
    expect(submission.json().replayed).toBe(false);

    const replayRequest = buildSubmissionRequest();
    const replay = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${firstMilestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": idempotencyKey,
        "Content-Type": replayRequest.headers.get("Content-Type") ?? "",
      },
      payload: Buffer.from(await replayRequest.arrayBuffer()),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);

    const submittedView = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(submittedView.milestones[0]).toEqual(expect.objectContaining({
      status: "submitted",
      reviewDeadline: expect.any(String),
      submissions: [expect.objectContaining({
        submissionNumber: 1,
        note: "The first milestone is complete and ready for review.",
        evidence: [expect.objectContaining({ fileName: "proof.pdf" })],
      })],
    }));

    const storedSubmission = submittedView.milestones[0].submissions[0];
    const storedEvidence = storedSubmission.evidence[0];
    const downloadUrl = `/api/dashboard/escrows/${createdEscrowReference}/milestones/${firstMilestone.id}/submissions/${storedSubmission.id}/evidence/${storedEvidence.id}`;
    const unauthorizedDownload = await server.inject({ method: "GET", url: downloadUrl });
    expect(unauthorizedDownload.statusCode).toBe(401);

    const buyerDownload = await server.inject({
      method: "GET",
      url: downloadUrl,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(buyerDownload.statusCode).toBe(200);
    expect(buyerDownload.rawPayload).toEqual(proofContents);
    expect(buyerDownload.headers["content-disposition"]).toContain("proof.pdf");
    expect(buyerDownload.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("releases a milestone only once when duplicate requests arrive together", async () => {
    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(escrowsResponse.statusCode).toBe(200);
    const targetEscrow = escrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === createdEscrowReference);
    expect(targetEscrow).toBeDefined();
    expect(targetEscrow.buyerSignatureDataUrl).toBe(creatorSignature);
    expect(targetEscrow.sellerSignatureDataUrl).toBe(counterpartySignature);
    expect(targetEscrow.createdAt).toBeTruthy();
    expect(targetEscrow.approvedAt).toBeTruthy();
    createdMilestoneId = targetEscrow.milestones[0].id;

    const sellerBefore = await server.prisma.user.findUniqueOrThrow({
      where: { email: "nora@example.com" },
    });
    const milestoneBefore = await server.prisma.escrowMilestone.findUniqueOrThrow({
      where: { id: createdMilestoneId },
    });
    const releaseEntriesBefore = await server.prisma.walletTransaction.count({
      where: { userId: sellerBefore.id, type: "RELEASE", amountCents: milestoneBefore.amountCents },
    });

    const idempotencyKey = `release-${createdEscrowReference}-${createdMilestoneId}`;
    const responses = await Promise.all([
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${createdMilestoneId}/approve`,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
      }),
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${createdMilestoneId}/approve`,
        headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses[0].json()).toEqual(responses[1].json());

    const sellerAfter = await server.prisma.user.findUniqueOrThrow({
      where: { id: sellerBefore.id },
    });
    const releaseEntriesAfter = await server.prisma.walletTransaction.count({
      where: { userId: sellerBefore.id, type: "RELEASE", amountCents: milestoneBefore.amountCents },
    });
    expect(sellerAfter.walletBalanceCents).toBe(sellerBefore.walletBalanceCents + milestoneBefore.amountCents);
    expect(releaseEntriesAfter).toBe(releaseEntriesBefore + 1);
    expect(await server.prisma.escrowLedgerEntry.count({
      where: { milestoneId: createdMilestoneId, movementType: "release" },
    })).toBe(1);
    const releasedView = (await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    })).json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(releasedView.balances.fundedCents).toBe(
      releasedView.balances.heldCents
      + releasedView.balances.releasedCents
      + releasedView.balances.refundedCents,
    );
    expect(releasedView.balances.releasedCents).toBe(milestoneBefore.amountCents);

    const reusedKeyResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${targetEscrow.milestones[1].id}/approve`,
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
    });
    expect(reusedKeyResponse.statusCode).toBe(409);
    expect(reusedKeyResponse.json().error).toBe(
      "This idempotency key was already used for a different request.",
    );

    const ledgerHistory = await server.inject({
      method: "GET",
      url: `/api/dashboard/escrows/${createdEscrowReference}/ledger`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ledgerHistory.statusCode).toBe(200);
    expect(ledgerHistory.json().balances).toEqual(releasedView.balances);
    expect(ledgerHistory.json().entries).toEqual([
      expect.objectContaining({ movementType: "fund", amountCents: releasedView.balances.fundedCents }),
      expect.objectContaining({
        movementType: "release",
        amountCents: -milestoneBefore.amountCents,
        milestone: expect.objectContaining({ id: createdMilestoneId }),
      }),
    ]);
  });

  it("keeps the escrow funded until all milestones are released", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const targetEscrow = response
      .json()
      .escrows.find((escrow: any) => escrow.id === createdEscrowReference);
    expect(targetEscrow.lifecycleStatus).toBe("funded");
    expect(targetEscrow.stage).toBe("Milestones active");
    expect(targetEscrow.milestones[0].status).toBe("released");
    expect(targetEscrow.milestones[1].status).toBe("not_started");
  });

  it("allows only one outcome when milestone approval and rejection race", async () => {
    const escrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: createdEscrowReference },
      include: { milestones: { orderBy: { orderIndex: "asc" } } },
    });
    const milestone = escrow.milestones[1];
    expect(milestone?.status).toBe("not_started");
    if (!milestone) throw new Error("Expected a second milestone.");

    const submissionResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${milestone.id}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `race-submit-${milestone.id}`,
      },
      payload: { note: "The second milestone is ready for review." },
    });
    expect(submissionResponse.statusCode).toBe(200);

    const sellerBefore = await server.prisma.user.findUniqueOrThrow({
      where: { email: "nora@example.com" },
    });
    const releaseEntriesBefore = await server.prisma.walletTransaction.count({
      where: { userId: sellerBefore.id, type: "RELEASE", amountCents: milestone.amountCents },
    });

    const [approveResponse, rejectResponse] = await Promise.all([
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${milestone.id}/approve`,
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `race-approve-${createdEscrowReference}-${milestone.id}`,
        },
      }),
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${milestone.id}/reject`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { reason: "Please correct the final deliverable." },
      }),
    ]);

    expect([approveResponse.statusCode, rejectResponse.statusCode].sort()).toEqual([200, 409]);

    const milestoneAfter = await server.prisma.escrowMilestone.findUniqueOrThrow({
      where: { id: milestone.id },
    });
    const sellerAfter = await server.prisma.user.findUniqueOrThrow({
      where: { id: sellerBefore.id },
    });
    const releaseEntriesAfter = await server.prisma.walletTransaction.count({
      where: { userId: sellerBefore.id, type: "RELEASE", amountCents: milestone.amountCents },
    });

    if (approveResponse.statusCode === 200) {
      expect(milestoneAfter.status).toBe("released");
      expect(sellerAfter.walletBalanceCents).toBe(sellerBefore.walletBalanceCents + milestone.amountCents);
      expect(releaseEntriesAfter).toBe(releaseEntriesBefore + 1);
    } else {
      expect(milestoneAfter.status).toBe("revision_requested");
      expect(sellerAfter.walletBalanceCents).toBe(sellerBefore.walletBalanceCents);
      expect(releaseEntriesAfter).toBe(releaseEntriesBefore);
    }
  });

  it("creates another funded escrow for rejection and resubmission checks", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "create-revision-workflow",
      },
      payload: {
        title: "Revision workflow escrow",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        amount: 900,
        signatureDataUrl: creatorSignature,
        milestones: [
          { title: "Draft", amount: 300 },
          { title: "Final", amount: 600 },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(201);
    secondMilestoneEscrowReference = createResponse.json().reference;

    const approveResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    });
    expect(approveResponse.statusCode).toBe(200);

    const fundResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/fund`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `fund-${secondMilestoneEscrowReference}`,
      },
    });
    expect(fundResponse.statusCode).toBe(200);
  });

  it("rejects and resubmits a milestone", async () => {
    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(escrowsResponse.statusCode).toBe(200);
    const targetEscrow = escrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === secondMilestoneEscrowReference);
    expect(targetEscrow).toBeDefined();
    rejectedMilestoneId = targetEscrow.milestones[0].id;

    const submitResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/submit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-${rejectedMilestoneId}-1`,
      },
      payload: { note: "Initial draft is ready." },
    });
    expect(submitResponse.statusCode).toBe(200);

    const missingReasonResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/reject`,
      headers: { Authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(missingReasonResponse.statusCode).toBe(400);

    const rejectResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/reject`,
      headers: { Authorization: `Bearer ${token}` },
      payload: { reason: "Please include the missing acceptance criteria." },
    });
    expect(rejectResponse.statusCode).toBe(200);

    const unchangedResubmitResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/resubmit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-${rejectedMilestoneId}-unchanged`,
      },
      payload: { note: "Initial draft is ready." },
    });
    expect(unchangedResubmitResponse.statusCode).toBe(400);

    const sellerResubmitResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/resubmit`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `submit-${rejectedMilestoneId}-2`,
      },
      payload: { note: "Updated draft now includes all acceptance criteria." },
    });
    expect(sellerResubmitResponse.statusCode).toBe(200);

    const refreshedEscrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const refreshedEscrow = refreshedEscrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === secondMilestoneEscrowReference);
    expect(refreshedEscrow.lifecycleStatus).toBe("funded");
    expect(refreshedEscrow.milestones[0].status).toBe("submitted");
    expect(refreshedEscrow.milestones[0].submissions).toHaveLength(2);
    expect(refreshedEscrow.milestones[0].submissions[0].review).toEqual(expect.objectContaining({
      decision: "revision_requested",
      reason: "Please include the missing acceptance criteria.",
    }));
  });

  it("holds funds and escalates when a milestone review is overdue", async () => {
    const escrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: secondMilestoneEscrowReference },
    });
    await server.prisma.escrowMilestone.update({
      where: { id: rejectedMilestoneId },
      data: {
        reviewDeadline: new Date("2026-07-23T00:00:00.000Z"),
        reminderAt: new Date("2026-07-21T00:00:00.000Z"),
      },
    });

    const reminderResult = await processMilestoneReviewDeadlines(
      server.prisma,
      new Date("2026-07-22T12:00:00.000Z"),
    );
    expect(reminderResult).toEqual(expect.objectContaining({
      policy: "hold_and_escalate",
      remindersSent: 1,
      escalated: 0,
    }));

    await server.prisma.escrowMilestone.update({
      where: { id: rejectedMilestoneId },
      data: { reviewDeadline: new Date("2026-07-20T00:00:00.000Z") },
    });
    const result = await processMilestoneReviewDeadlines(
      server.prisma,
      new Date("2026-07-22T12:00:00.000Z"),
    );
    expect(result).toEqual(expect.objectContaining({
      policy: "hold_and_escalate",
      escalated: 1,
    }));

    const milestone = await server.prisma.escrowMilestone.findUniqueOrThrow({
      where: { id: rejectedMilestoneId },
    });
    expect(milestone.status).toBe("submitted");
    expect(milestone.reviewOverdueAt).toEqual(new Date("2026-07-22T12:00:00.000Z"));
    expect(await server.prisma.escrowLedgerEntry.count({
      where: { escrowId: escrow.id, movementType: "release" },
    })).toBe(0);
  });

  it("tops up the wallet", async () => {
    const key = "wallet-topup-test";
    const transactionsBefore = await server.prisma.walletTransaction.count({
      where: { type: "TOPUP" },
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/topup",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key },
      payload: { amount: 2500 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().balance).toBeGreaterThan(0);
    const replay = await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/topup",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key },
      payload: { amount: 2500 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());
    expect(await server.prisma.walletTransaction.count({ where: { type: "TOPUP" } }))
      .toBe(transactionsBefore + 1);
  });

  it("records wallet withdrawals as debits", async () => {
    const withdrawResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/withdraw",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": "wallet-withdraw-test" },
      payload: { amount: 100 },
    });
    expect(withdrawResponse.statusCode).toBe(200);

    const transactionsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/wallet/transactions",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(transactionsResponse.statusCode).toBe(200);
    expect(transactionsResponse.json().transactions[0]).toEqual(
      expect.objectContaining({ type: "WITHDRAW", direction: "debit" }),
    );
  });

  it("lists wallet transactions", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/dashboard/wallet/transactions",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.length).toBeGreaterThan(0);
    expect(body.transactions[0]).toHaveProperty("type");
    expect(body.transactions[0]).toHaveProperty("amount");
  });

  it("opens one milestone dispute and reserves only that milestone balance", async () => {
    const requests = await Promise.all([
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/dispute`,
        headers: {
          Authorization: `Bearer ${token}`,
          "Idempotency-Key": `open-dispute-${rejectedMilestoneId}-a`,
        },
        payload: { reason: "The revised delivery still does not meet the agreed acceptance criteria." },
      }),
      server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/dispute`,
        headers: {
          Authorization: `Bearer ${counterpartyToken}`,
          "Idempotency-Key": `open-dispute-${rejectedMilestoneId}-b`,
        },
        payload: { reason: "The parties disagree about whether the revised acceptance criteria were met." },
      }),
    ]);
    expect(requests.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    phaseFourDisputeReference = requests.find((response) => response.statusCode === 200)!.json().disputeId;

    const escrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: secondMilestoneEscrowReference },
      include: { milestones: true },
    });
    const milestone = escrow.milestones.find((item) => item.id === rejectedMilestoneId);
    expect(milestone?.status).toBe("disputed");
    expect(await server.prisma.dispute.count({
      where: { milestoneId: rejectedMilestoneId, status: { in: ["open", "resolution_proposed", "resolving", "arbitration_requested"] } },
    })).toBe(1);

    const ledger = await server.inject({
      method: "GET",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/ledger`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ledger.json().balances).toEqual(expect.objectContaining({
      heldCents: 90_000,
      disputedCents: 30_000,
    }));
  });

  it("stores managed evidence and requires a complete mutual resolution allocation", async () => {
    const buildEvidenceRequest = () => {
      const evidenceForm = new FormData();
      evidenceForm.append(
        "note",
        "Attached delivery notes explain the seller's interpretation of the criteria.",
      );
      evidenceForm.append(
        "evidence",
        new Blob([phaseFourDisputeEvidenceBytes], { type: "text/plain" }),
        phaseFourDisputeEvidenceFileName,
      );
      return new Request("http://localhost/upload", {
        method: "POST",
        body: evidenceForm,
      });
    };
    const evidenceRequest = buildEvidenceRequest();
    const evidenceIdempotencyKey = `evidence-${phaseFourDisputeReference}`;
    const evidenceResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/evidence`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": evidenceIdempotencyKey,
        "Content-Type": evidenceRequest.headers.get("Content-Type") ?? "",
      },
      payload: Buffer.from(await evidenceRequest.arrayBuffer()),
    });
    expect(evidenceResponse.statusCode).toBe(200);
    expect(evidenceResponse.json()).toEqual(expect.objectContaining({
      success: true,
      disputeId: phaseFourDisputeReference,
      evidenceSubmissionId: expect.any(Number),
      replayed: false,
    }));
    const replayRequest = buildEvidenceRequest();
    const replayResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/evidence`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": evidenceIdempotencyKey,
        "Content-Type": replayRequest.headers.get("Content-Type") ?? "",
      },
      payload: Buffer.from(await replayRequest.arrayBuffer()),
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json()).toEqual({
      ...evidenceResponse.json(),
      replayed: true,
    });

    const storedEvidence = await server.prisma.disputeEvidenceReference.findFirstOrThrow({
      where: {
        submission: {
          dispute: { reference: phaseFourDisputeReference },
        },
      },
      orderBy: { id: "desc" },
    });
    expect(await server.prisma.disputeEvidenceReference.count({
      where: {
        submission: {
          dispute: { reference: phaseFourDisputeReference },
        },
      },
    })).toBe(1);
    phaseFourDisputeExhibitId = `dispute-${storedEvidence.id}`;
    expect(storedEvidence).toEqual(expect.objectContaining({
      fileName: phaseFourDisputeEvidenceFileName,
      contentType: "text/plain",
      sizeBytes: phaseFourDisputeEvidenceBytes.byteLength,
      sha256: phaseFourDisputeEvidenceSha256,
    }));

    const untrustedObjectKey = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/evidence`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": `untrusted-evidence-${phaseFourDisputeReference}`,
      },
      payload: {
        evidence: [{
          objectKey: storedEvidence.objectKey,
          fileName: "forged-reference.txt",
          contentType: "text/plain",
          sizeBytes: storedEvidence.sizeBytes,
          sha256: storedEvidence.sha256,
        }],
      },
    });
    expect(untrustedObjectKey.statusCode).toBe(400);

    const [dispute, seller, latestMilestoneSubmission] = await Promise.all([
      server.prisma.dispute.findUniqueOrThrow({
        where: { reference: phaseFourDisputeReference },
        select: { id: true },
      }),
      server.prisma.user.findUniqueOrThrow({
        where: { email: "nora@example.com" },
        select: { id: true },
      }),
      server.prisma.milestoneSubmission.findFirstOrThrow({
        where: { milestoneId: rejectedMilestoneId },
        orderBy: { submissionNumber: "desc" },
        select: { id: true },
      }),
    ]);
    const legacyDisputeSubmission = await server.prisma.disputeEvidenceSubmission.create({
      data: {
        disputeId: dispute.id,
        submitterId: seller.id,
        note: "Historic metadata imported before MyEscrow managed evidence files.",
        files: {
          create: {
            objectKey: storedEvidence.objectKey,
            fileName: phaseFourLegacyDisputeFileName,
            contentType: storedEvidence.contentType,
            sizeBytes: storedEvidence.sizeBytes,
            sha256: storedEvidence.sha256,
            storageStatus: "legacy_metadata",
          },
        },
      },
      include: { files: true },
    });
    const legacyDisputeEvidence = legacyDisputeSubmission.files[0];
    if (!legacyDisputeEvidence) throw new Error("Expected a legacy dispute evidence reference.");
    phaseFourLegacyDisputeExhibitId = `dispute-${legacyDisputeEvidence.id}`;
    expect(legacyDisputeEvidence.storageStatus).toBe("legacy_metadata");

    const legacyMilestoneEvidence = await server.prisma.milestoneEvidenceReference.create({
      data: {
        submissionId: latestMilestoneSubmission.id,
        objectKey: storedEvidence.objectKey,
        fileName: phaseFourLegacyMilestoneFileName,
        contentType: storedEvidence.contentType,
        sizeBytes: storedEvidence.sizeBytes,
        sha256: storedEvidence.sha256,
        storageStatus: "legacy_metadata",
      },
    });
    phaseFourLegacyMilestoneExhibitId = `milestone-${legacyMilestoneEvidence.id}`;
    expect(legacyMilestoneEvidence.storageStatus).toBe("legacy_metadata");

    const exhibitBeforeArbitration = await server.inject({
      method: "GET",
      url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourDisputeExhibitId}`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    expect(exhibitBeforeArbitration.statusCode).toBe(409);
    expect(exhibitBeforeArbitration.json().error).toBe(
      "Arbitration exhibits are available only after arbitration is requested.",
    );

    const invalidProposal = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/resolution`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `bad-resolution-${phaseFourDisputeReference}`,
      },
      payload: { sellerAmount: 120, buyerAmount: 100, note: "Incomplete allocation" },
    });
    expect(invalidProposal.statusCode).toBe(400);

    const proposal = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/resolution`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `resolution-${phaseFourDisputeReference}`,
      },
      payload: { sellerAmount: 120, buyerAmount: 180, note: "Split settlement proposed by the buyer." },
    });
    expect(proposal.statusCode).toBe(200);

    const selfAcceptance = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/resolve`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `self-accept-${phaseFourDisputeReference}`,
      },
    });
    expect(selfAcceptance.statusCode).toBe(403);
  });

  it("refunds only undisputed, unreleased funds after mutual cancellation", async () => {
    const request = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/cancellation/request`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `cancel-request-${secondMilestoneEscrowReference}`,
      },
      payload: {
        mode: "mutual",
        reason: "Both parties agree to stop before work begins on the final milestone.",
      },
    });
    expect(request.statusCode).toBe(200);
    phaseFourCancellationReference = request.json().cancellationId;

    const selfAcceptance = await server.inject({
      method: "POST",
      url: `/api/dashboard/cancellations/${phaseFourCancellationReference}/accept`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `self-cancel-${phaseFourCancellationReference}`,
      },
    });
    expect(selfAcceptance.statusCode).toBe(403);

    const buyerBefore = await server.prisma.user.findUniqueOrThrow({ where: { email: "scott@example.com" } });
    const acceptKey = `accept-cancel-${phaseFourCancellationReference}`;
    const acceptance = await server.inject({
      method: "POST",
      url: `/api/dashboard/cancellations/${phaseFourCancellationReference}/accept`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": acceptKey,
      },
    });
    expect(acceptance.statusCode).toBe(200);
    expect(acceptance.json()).toEqual(expect.objectContaining({ refundedCents: 60_000, disputedCents: 30_000 }));
    const replay = await server.inject({
      method: "POST",
      url: `/api/dashboard/cancellations/${phaseFourCancellationReference}/accept`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": acceptKey,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(acceptance.json());

    const buyerAfter = await server.prisma.user.findUniqueOrThrow({ where: { id: buyerBefore.id } });
    expect(buyerAfter.walletBalanceCents).toBe(buyerBefore.walletBalanceCents + 60_000);
    const cancellation = await server.prisma.cancellationRequest.findUniqueOrThrow({
      where: { reference: phaseFourCancellationReference },
      include: { escrow: { include: { milestones: { orderBy: { orderIndex: "asc" } } } } },
    });
    expect(cancellation.status).toBe("accepted");
    expect(cancellation.escrow.lifecycleStatus).toBe("dispute_resolution_pending");
    expect(cancellation.escrow.milestones[0]?.status).toBe("disputed");
    expect(cancellation.escrow.milestones[1]?.status).toBe("cancelled");
    expect(await server.prisma.escrowLedgerEntry.count({
      where: { businessReference: `cancellation:${phaseFourCancellationReference}:refund` },
    })).toBe(1);
  });

  it("allocates every frozen dollar after cancellation and then closes the escrow", async () => {
    const acceptanceKey = `accept-resolution-${phaseFourDisputeReference}`;
    const acceptance = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/resolve`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": acceptanceKey,
      },
    });
    expect(acceptance.statusCode).toBe(200);
    expect(acceptance.json()).toEqual(expect.objectContaining({
      disputeId: phaseFourDisputeReference,
      sellerCents: 12_000,
      buyerCents: 18_000,
      status: "resolved",
    }));
    const replay = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/resolve`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": acceptanceKey,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(acceptance.json());

    const allocations = await server.prisma.disputeResolutionAllocation.findMany({
      where: { dispute: { reference: phaseFourDisputeReference } },
      include: { ledgerEntry: true },
    });
    expect(allocations.reduce((total, allocation) => total + allocation.amountCents, 0)).toBe(30_000);
    expect(allocations.map((allocation) => allocation.recipient).sort()).toEqual(["buyer", "seller"]);
    expect(allocations.every((allocation) => allocation.ledgerEntry.milestoneId === rejectedMilestoneId)).toBe(true);

    const escrow = await server.prisma.escrow.findUniqueOrThrow({
      where: { reference: secondMilestoneEscrowReference },
      include: { milestones: { orderBy: { orderIndex: "asc" } } },
    });
    expect(escrow.lifecycleStatus).toBe("cancelled");
    expect(escrow.milestones[0]?.status).toBe("settled");
    expect(escrow.milestones[1]?.status).toBe("cancelled");
  });

  it("escalates unilateral cancellation without moving funds", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": "create-unilateral-cancellation",
      },
      payload: {
        title: "Administrative cancellation escrow",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        amount: 100,
        signatureDataUrl: creatorSignature,
        milestones: [{ title: "Reviewed work", amount: 100 }],
      },
    });
    const reference = create.json().reference;
    governedCancellationReference = reference;
    await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    });
    await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/fund`,
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": `fund-${reference}` },
    });
    const refundCountBefore = await server.prisma.escrowLedgerEntry.count({ where: { movementType: "refund" } });
    const request = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${reference}/cancellation/request`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": `unilateral-${reference}`,
      },
      payload: {
        mode: "unilateral",
        reason: "The buyer is requesting administrative review because mutual agreement was not reached.",
      },
    });
    expect(request.statusCode).toBe(200);
    expect(request.json().status).toBe("escalated");
    const escrow = await server.prisma.escrow.findUniqueOrThrow({ where: { reference } });
    expect(escrow.lifecycleStatus).toBe("cancellation_review");
    expect(await server.prisma.escrowLedgerEntry.count({ where: { movementType: "refund" } })).toBe(refundCountBefore);

    const ledger = await server.inject({
      method: "GET",
      url: `/api/dashboard/escrows/${reference}/ledger`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ledger.json().balances.heldCents).toBe(10_000);

    const { getOperationsHealth } = await import("../services/operationsService");
    const operationsHealth = await getOperationsHealth(server.prisma);
    expect(operationsHealth.counts.cancellationReviews).toBeGreaterThanOrEqual(1);
    expect(
      operationsHealth.alerts.some((alert) =>
        alert.includes("request(s) awaiting administrative review"),
      ),
    ).toBe(true);
    expect(operationsHealth.details.cancellationReviews).toContainEqual(
      expect.objectContaining({
        mode: "unilateral",
        status: "escalated",
        escalatedAt: expect.any(Date),
        escrow: expect.objectContaining({ reference }),
      }),
    );
  });

  it("runs durable recovery jobs and exposes permissioned support tools and audit history", async () => {
    const denied = await server.inject({
      method: "GET",
      url: "/api/operations/health",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(denied.statusCode).toBe(403);
    const arbitrationRecordDenied = await server.inject({
      method: "GET",
      url: `/api/operations/disputes/${phaseFourDisputeReference}/evidence`,
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    expect(arbitrationRecordDenied.statusCode).toBe(403);
    const reportBeforeArbitration = await server.inject({
      method: "GET",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/arbitration-report`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(reportBeforeArbitration.statusCode).toBe(409);

    const operator = await server.prisma.user.update({
      where: { email: "scott@example.com" },
      data: { operatorRole: "support" },
    });
    const operatorLogin = await server.inject({
      method: "POST",
      url: "/api/auth/operations-login",
      payload: { email: "scott@example.com", password: "BetterPassword123!" },
    });
    expect(operatorLogin.statusCode).toBe(200);
    expect(operatorLogin.json().user).toEqual(expect.objectContaining({ role: "support" }));
    const operatorToken = operatorLogin.json().token as string;
    expect(server.jwt.decode<{ portal: string }>(operatorToken)?.portal).toBe("operations");

    const operatorCustomerLogin = await server.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "scott@example.com", password: "BetterPassword123!" },
    });
    expect(operatorCustomerLogin.statusCode).toBe(200);
    expect(operatorCustomerLogin.json().user).toEqual(expect.objectContaining({ role: "customer" }));

    const operatorCustomerApi = await server.inject({
      method: "GET",
      url: "/api/dashboard/overview",
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(operatorCustomerApi.statusCode).toBe(403);
    expect((await server.inject({
      method: "GET",
      url: "/api/dashboard/overview",
      headers: { Authorization: `Bearer ${operatorCustomerLogin.json().token}` },
    })).statusCode).toBe(200);

    const supportCannotGrant = await server.inject({
      method: "POST",
      url: "/api/operations/operators/role",
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": "support-cannot-grant-role" },
      payload: { email: "scott@example.com", role: "admin" },
    });
    expect(supportCannotGrant.statusCode).toBe(403);

    const { bootstrapFirstAdmin } = await import("../services/operatorService");
    const firstAdmin = await bootstrapFirstAdmin(server.prisma, "nora@example.com");
    expect(firstAdmin).toEqual(expect.objectContaining({ role: "admin", changed: true }));
    await expect(bootstrapFirstAdmin(server.prisma, "scott@example.com")).rejects.toMatchObject({ statusCode: 409 });
    const adminLogin = await server.inject({
      method: "POST",
      url: "/api/auth/operations-login",
      payload: { email: "nora@example.com", password: "StrongerPassword456!" },
    });
    expect(adminLogin.statusCode).toBe(200);
    const adminToken = adminLogin.json().token as string;

    const operators = await server.inject({
      method: "GET",
      url: "/api/operations/operators",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(operators.statusCode).toBe(200);
    expect(operators.json().operators).toHaveLength(2);

    const grantKey = "admin-grant-scott";
    const grant = await server.inject({
      method: "POST",
      url: "/api/operations/operators/role",
      headers: { Authorization: `Bearer ${adminToken}`, "Idempotency-Key": grantKey },
      payload: { email: "scott@example.com", role: "admin" },
    });
    expect(grant.statusCode).toBe(200);
    const grantReplay = await server.inject({
      method: "POST",
      url: "/api/operations/operators/role",
      headers: { Authorization: `Bearer ${adminToken}`, "Idempotency-Key": grantKey },
      payload: { email: "scott@example.com", role: "admin" },
    });
    expect(grantReplay.json()).toEqual(grant.json());
    const demoteFirstAdmin = await server.inject({
      method: "POST",
      url: "/api/operations/operators/role",
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": "demote-first-admin" },
      payload: { email: "nora@example.com", role: "customer" },
    });
    expect(demoteFirstAdmin.statusCode).toBe(200);
    const demoteFinalAdmin = await server.inject({
      method: "POST",
      url: "/api/operations/operators/role",
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": "protect-final-admin" },
      payload: { email: "scott@example.com", role: "customer" },
    });
    expect(demoteFinalAdmin.statusCode).toBe(409);

    const delivery = await server.prisma.invitationDelivery.findFirstOrThrow({
      where: { acceptedAt: null, supersededAt: null, status: { notIn: ["accepted", "corrected"] } },
      orderBy: { id: "desc" },
    });
    const extendKey = `support-extend-${delivery.id}`;
    const extended = await server.inject({
      method: "POST",
      url: `/api/operations/invitations/${delivery.id}/extend`,
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": extendKey },
      payload: { days: 5 },
    });
    expect(extended.statusCode).toBe(200);
    const extendedReplay = await server.inject({
      method: "POST",
      url: `/api/operations/invitations/${delivery.id}/extend`,
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": extendKey },
      payload: { days: 5 },
    });
    expect(extendedReplay.json()).toEqual(extended.json());

    const recoveryNow = new Date("2026-09-30T12:00:00.000Z");
    await server.prisma.invitationDelivery.update({
      where: { id: delivery.id },
      data: {
        responseDueAt: new Date(recoveryNow.getTime() - 2 * 86_400_000),
        expiresAt: new Date(recoveryNow.getTime() - 86_400_000),
      },
    });
    const { runOperationalRecovery } = await import("../services/operationsService");
    const result = await runOperationalRecovery(server.prisma, server.log, recoveryNow, 100);
    expect(result.failed).toBe(0);
    expect(result.completed).toBeGreaterThan(0);
    expect((await server.prisma.operationalWorkerState.findUniqueOrThrow({ where: { id: "primary" } })).lastSuccessAt).toBeTruthy();
    expect((await server.prisma.invitationDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe("expired");
    const reopened = await server.inject({
      method: "POST",
      url: `/api/operations/invitations/${delivery.id}/extend`,
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": `support-reopen-${delivery.id}` },
      payload: { days: 7 },
    });
    expect(reopened.statusCode).toBe(200);
    const reopenedDelivery = await server.prisma.invitationDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      include: { escrow: true },
    });
    expect(reopenedDelivery.status).toBe("delivered");
    expect(reopenedDelivery.escrow.lifecycleStatus).not.toBe("invitation_expired");
    expect(await server.prisma.auditEvent.count({ where: { actorId: operator.id } })).toBeGreaterThan(0);
    expect((await server.prisma.reconciliationRun.findFirstOrThrow({ orderBy: { startedAt: "desc" } })).status).toBe("clean");

    const failedJob = await server.prisma.operationalJob.create({
      data: {
        jobType: "funding_timeout",
        dedupeKey: "test-failed-operational-job",
        payload: { escrowId: -1 },
        status: "failed",
        runAt: recoveryNow,
        attemptCount: 5,
        lastError: "simulated failure",
      },
    });
    const retryKey = `retry-job-${failedJob.id}`;
    const retried = await server.inject({
      method: "POST",
      url: `/api/operations/jobs/${failedJob.id}/retry`,
      headers: { Authorization: `Bearer ${operatorToken}`, "Idempotency-Key": retryKey },
    });
    expect(retried.statusCode).toBe(200);
    expect((await server.prisma.operationalJob.findUniqueOrThrow({ where: { id: failedJob.id } })).status).toBe("pending");

    await server.prisma.dispute.update({
      where: { reference: phaseFourDisputeReference },
      data: {
        status: "arbitration_requested",
        arbitrationRequestedAt: recoveryNow,
        arbitrationRequestedById: operator.id,
      },
    });
    const arbitrationChatMessage = "Please include the delivery discussion in the arbitration record.";
    const chat = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/messages`,
      headers: {
        Authorization: `Bearer ${counterpartyToken}`,
        "Idempotency-Key": "arbitration-record-message",
      },
      payload: { body: arbitrationChatMessage },
    });
    expect(chat.statusCode).toBe(201);

    const unrelatedPartyReport = await server.inject({
      method: "GET",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/arbitration-report`,
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    expect(unrelatedPartyReport.statusCode).toBe(403);
    const unrelatedPartyExhibit = await server.inject({
      method: "GET",
      url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourDisputeExhibitId}`,
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}` },
    });
    expect(unrelatedPartyExhibit.statusCode).toBe(403);
    expect(unrelatedPartyExhibit.json().error).toBe(
      "Only the affected parties or an authorized operator can access arbitration exhibits.",
    );

    const partyReport = await server.inject({
      method: "GET",
      url: `/api/dashboard/disputes/${phaseFourDisputeReference}/arbitration-report`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    expect(partyReport.statusCode).toBe(200);
    expect(partyReport.headers["cache-control"]).toBe("private, no-store");

    const evidence = await server.inject({
      method: "GET",
      url: `/api/operations/disputes/${phaseFourDisputeReference}/arbitration-report`,
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.headers["cache-control"]).toBe("private, no-store");
    const partyReportBody = partyReport.json();
    const operationsReportBody = evidence.json();
    expect(operationsReportBody.evidence.length).toBeGreaterThan(0);
    expect(operationsReportBody).toEqual(expect.objectContaining({
      reportVersion: 2,
      reportId: `MYE-ARB-${phaseFourDisputeReference}`,
      generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      integritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      case: expect.objectContaining({
        reference: phaseFourDisputeReference,
        arbitrationRequestedAt: recoveryNow.toISOString(),
      }),
      escrow: expect.objectContaining({ reference: secondMilestoneEscrowReference }),
      parties: expect.arrayContaining([
        expect.objectContaining({ name: "Scott", role: "buyer" }),
        expect.objectContaining({ name: "Nora Studio", role: "seller" }),
      ]),
      agreement: expect.objectContaining({
        status: "locked",
        termsHash: expect.any(String),
        signatures: expect.arrayContaining([
          expect.objectContaining({
            signerRole: "buyer",
            evidenceHash: expect.any(String),
          }),
          expect.objectContaining({
            signerRole: "seller",
            evidenceHash: expect.any(String),
          }),
        ]),
      }),
      chatLog: [
        expect.objectContaining({
          body: arbitrationChatMessage,
          sentAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          sender: expect.objectContaining({ name: "Nora Studio", role: "seller" }),
        }),
      ],
      financialLedger: expect.any(Array),
      exhibits: expect.arrayContaining([
        expect.objectContaining({
          id: phaseFourDisputeExhibitId,
          source: "dispute_evidence",
          fileName: phaseFourDisputeEvidenceFileName,
          contentType: "text/plain",
          sizeBytes: phaseFourDisputeEvidenceBytes.byteLength,
          sha256: phaseFourDisputeEvidenceSha256,
        }),
      ]),
      timeline: expect.arrayContaining([
        expect.objectContaining({ type: "arbitration", action: "requested" }),
      ]),
    }));
    expect(operationsReportBody.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        references: expect.arrayContaining([
          expect.objectContaining({
            exhibitId: phaseFourDisputeExhibitId,
            fileName: phaseFourDisputeEvidenceFileName,
            sha256: phaseFourDisputeEvidenceSha256,
            storageStatus: "managed",
          }),
        ]),
      }),
    ]));
    const reportDisputeEvidenceReferences = operationsReportBody.evidence.flatMap(
      (submission: { references: Array<Record<string, unknown>> }) => submission.references,
    );
    expect(reportDisputeEvidenceReferences.find(
      (reference: { fileName?: string }) =>
        reference.fileName === phaseFourDisputeEvidenceFileName,
    )).toEqual(expect.objectContaining({
      exhibitId: phaseFourDisputeExhibitId,
      storageStatus: "managed",
    }));
    expect(reportDisputeEvidenceReferences.find(
      (reference: { fileName?: string }) =>
        reference.fileName === phaseFourLegacyDisputeFileName,
    )).toEqual(expect.objectContaining({
      exhibitId: null,
      fileName: phaseFourLegacyDisputeFileName,
      storageStatus: "metadata_only",
    }));
    const reportMilestoneEvidence = operationsReportBody.disputedMilestone.submissions.flatMap(
      (submission: { evidence: Array<Record<string, unknown>> }) => submission.evidence,
    );
    expect(reportMilestoneEvidence.find(
      (reference: { fileName?: string }) =>
        reference.fileName === phaseFourLegacyMilestoneFileName,
    )).toEqual(expect.objectContaining({
      exhibitId: null,
      fileName: phaseFourLegacyMilestoneFileName,
      storageStatus: "metadata_only",
    }));
    const reportExhibitIds = operationsReportBody.exhibits.map(
      (exhibit: { id: string }) => exhibit.id,
    );
    expect(reportExhibitIds).toContain(phaseFourDisputeExhibitId);
    expect(reportExhibitIds).not.toContain(phaseFourLegacyDisputeExhibitId);
    expect(reportExhibitIds).not.toContain(phaseFourLegacyMilestoneExhibitId);
    expect(JSON.stringify(operationsReportBody)).not.toContain("\"objectKey\"");
    expect(partyReportBody).toEqual(expect.objectContaining({
      reportVersion: operationsReportBody.reportVersion,
      reportId: operationsReportBody.reportId,
      integritySha256: operationsReportBody.integritySha256,
      exhibits: operationsReportBody.exhibits,
      chatLog: operationsReportBody.chatLog,
    }));
    expect({
      ...partyReportBody,
      generatedAt: operationsReportBody.generatedAt,
    }).toEqual(operationsReportBody);

    const affectedPartyExhibit = await server.inject({
      method: "GET",
      url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourDisputeExhibitId}`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });

    await server.prisma.user.update({
      where: { email: "jamie.contractor@example.com" },
      data: { operatorRole: "support" },
    });
    const exhibitOperatorLogin = await server.inject({
      method: "POST",
      url: "/api/auth/operations-login",
      payload: { email: "jamie.contractor@example.com", password: "InviteFlowPass123!" },
    });
    expect(exhibitOperatorLogin.statusCode).toBe(200);
    const operatorExhibit = await server.inject({
      method: "GET",
      url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourDisputeExhibitId}`,
      headers: { Authorization: `Bearer ${exhibitOperatorLogin.json().token}` },
    });
    await server.prisma.user.update({
      where: { email: "jamie.contractor@example.com" },
      data: { operatorRole: null },
    });

    const expectedContentDisposition =
      `attachment; filename="${phaseFourDisputeEvidenceFileName}"; `
      + `filename*=UTF-8''${phaseFourDisputeEvidenceFileName}`;
    for (const exhibitResponse of [affectedPartyExhibit, operatorExhibit]) {
      expect(exhibitResponse.statusCode).toBe(200);
      expect(exhibitResponse.rawPayload).toEqual(phaseFourDisputeEvidenceBytes);
      expect(exhibitResponse.headers).toEqual(expect.objectContaining({
        "cache-control": "private, no-store",
        "content-disposition": expectedContentDisposition,
        "content-length": String(phaseFourDisputeEvidenceBytes.byteLength),
        "content-type": "text/plain",
        "x-content-sha256": phaseFourDisputeEvidenceSha256,
        "x-content-type-options": "nosniff",
      }));
    }

    const managedEvidence = await server.prisma.disputeEvidenceReference.findFirstOrThrow({
      where: {
        storageStatus: "managed",
        submission: {
          dispute: { reference: phaseFourDisputeReference },
        },
      },
    });
    const managedEvidencePath = path.join(
      proofStorageDir,
      managedEvidence.objectKey.replace(/^milestone-proofs\//, ""),
    );
    const tamperedEvidenceBytes = Buffer.from(phaseFourDisputeEvidenceBytes);
    tamperedEvidenceBytes[0] = tamperedEvidenceBytes[0]! ^ 0xff;
    await writeFile(managedEvidencePath, tamperedEvidenceBytes);
    try {
      const tamperedExhibit = await server.inject({
        method: "GET",
        url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourDisputeExhibitId}`,
        headers: { Authorization: `Bearer ${counterpartyToken}` },
      });
      expect(tamperedExhibit.statusCode).toBe(409);
      expect(tamperedExhibit.json().error).toBe(
        "Evidence file failed its stored size or SHA-256 integrity check.",
      );
    } finally {
      await writeFile(managedEvidencePath, phaseFourDisputeEvidenceBytes);
    }

    const [legacyDisputeExhibit, legacyMilestoneExhibit] = await Promise.all([
      server.inject({
        method: "GET",
        url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourLegacyDisputeExhibitId}`,
        headers: { Authorization: `Bearer ${counterpartyToken}` },
      }),
      server.inject({
        method: "GET",
        url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/${phaseFourLegacyMilestoneExhibitId}`,
        headers: { Authorization: `Bearer ${counterpartyToken}` },
      }),
    ]);
    for (const legacyExhibitResponse of [legacyDisputeExhibit, legacyMilestoneExhibit]) {
      expect(legacyExhibitResponse.statusCode).toBe(404);
      expect(legacyExhibitResponse.json().error).toBe("Arbitration exhibit not found.");
    }

    const otherEscrowEvidence = await server.prisma.milestoneEvidenceReference.findFirstOrThrow({
      where: {
        submission: {
          milestone: {
            escrow: { reference: createdEscrowReference },
          },
        },
      },
      orderBy: { id: "asc" },
    });
    const crossEscrowExhibit = await server.inject({
      method: "GET",
      url: `/api/arbitration/disputes/${phaseFourDisputeReference}/exhibits/milestone-${otherEscrowEvidence.id}`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    expect(crossEscrowExhibit.statusCode).toBe(404);
    expect(crossEscrowExhibit.json().error).toBe("Arbitration exhibit not found.");

    const audit = await server.inject({
      method: "GET",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/audit`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().events.some((event: { type: string }) => event.type === "ledger")).toBe(true);
    expect(audit.json().events.some((event: { type: string }) => event.type === "dispute_evidence")).toBe(true);

    const health = await server.inject({
      method: "GET",
      url: "/api/operations/health",
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().currentRole).toBe("admin");
    expect(health.json().worker.status).toBe("healthy");
    expect(health.json().counts.duplicateCommandAttempts).toBeGreaterThan(0);
    expect(health.json().details).toEqual(expect.objectContaining({
      failedOutbox: expect.any(Array),
      failedJobs: expect.any(Array),
      agedEscrows: expect.any(Array),
      duplicateCommands: expect.any(Array),
      disputesApproaching: expect.any(Array),
      arbitrationRequested: expect.any(Array),
      cancellationReviews: expect.any(Array),
    }));
    expect(health.json().details.duplicateCommands.length).toBeGreaterThan(0);

    const arbitrationHealth = await server.inject({
      method: "GET",
      url: "/api/operations/health",
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(arbitrationHealth.json().counts.arbitrationRequested).toBe(1);
    expect(arbitrationHealth.json().alerts).toContain("Arbitration: 1 dispute(s) awaiting review");
    expect(arbitrationHealth.json().details.arbitrationRequested).toEqual([
      expect.objectContaining({ reference: phaseFourDisputeReference, status: "arbitration_requested" }),
    ]);

    await server.prisma.operationalWorkerState.update({
      where: { id: "primary" },
      data: { lastSuccessAt: new Date(Date.now() - 3 * 60_000) },
    });
    const staleHealth = await server.inject({
      method: "GET",
      url: "/api/operations/health",
      headers: { Authorization: `Bearer ${operatorToken}` },
    });
    expect(staleHealth.json().worker.status).toBe("stale");
    expect(staleHealth.json().alerts).toContain("Operational recovery worker has not completed successfully within two minutes");
  });

  it("keeps administrative cancellation review separate from merits adjudication", async () => {
    expect((await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/topup",
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}`, "Idempotency-Key": "administrative-review-wallet" },
      payload: { amount: 1000 },
    })).statusCode).toBe(200);

    const createFundedCancellation = async (suffix: string) => {
      const create = await server.inject({
        method: "POST",
        url: "/api/dashboard/escrows/create",
        headers: {
          Authorization: `Bearer ${invitedCounterpartyToken}`,
          "Idempotency-Key": `create-administrative-cancellation-${suffix}`,
        },
        payload: {
          title: `Administrative cancellation ${suffix}`,
          counterpartyEmail: "nora@example.com",
          creatorRole: "buyer",
          amount: 100,
          signatureDataUrl: creatorSignature,
          milestones: [{ title: `Work ${suffix}`, amount: 100 }],
        },
      });
      expect(create.statusCode).toBe(201);
      const escrowReference = create.json().reference as string;
      expect((await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${escrowReference}/approve`,
        headers: { Authorization: `Bearer ${counterpartyToken}` },
        payload: { signatureDataUrl: counterpartySignature },
      })).statusCode).toBe(200);
      expect((await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${escrowReference}/fund`,
        headers: { Authorization: `Bearer ${invitedCounterpartyToken}`, "Idempotency-Key": `fund-${suffix}` },
      })).statusCode).toBe(200);
      const request = await server.inject({
        method: "POST",
        url: `/api/dashboard/escrows/${escrowReference}/cancellation/request`,
        headers: { Authorization: `Bearer ${invitedCounterpartyToken}`, "Idempotency-Key": `cancel-${suffix}` },
        payload: {
          mode: "unilateral",
          reason: `Administrative cancellation requested for the ${suffix} workflow.`,
        },
      });
      expect(request.statusCode).toBe(200);
      const escrow = await server.prisma.escrow.findUniqueOrThrow({
        where: { reference: escrowReference },
        include: { milestones: true },
      });
      return {
        escrowReference,
        cancellationReference: request.json().cancellationId as string,
        milestoneId: escrow.milestones[0]!.id,
      };
    };

    const existingCancellation = await server.prisma.cancellationRequest.findFirstOrThrow({
      where: { escrow: { reference: governedCancellationReference } },
      include: { escrow: true },
    });
    const refundCountBefore = await server.prisma.escrowLedgerEntry.count({
      where: { movementType: "refund" },
    });

    await server.prisma.user.update({
      where: { email: "scott@example.com" },
      data: { operatorRole: "support" },
    });
    const administrativeOperatorLogin = await server.inject({
      method: "POST",
      url: "/api/auth/operations-login",
      payload: { email: "scott@example.com", password: "BetterPassword123!" },
    });
    expect(administrativeOperatorLogin.statusCode).toBe(200);
    const administrativeOperatorToken = administrativeOperatorLogin.json().token as string;
    const denied = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${existingCancellation.reference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": "support-admin-review-denied" },
      payload: {
        action: "request_information",
        rationale: "Provide the objective notice record for this request.",
      },
    });
    expect(denied.statusCode).toBe(403);
    await server.prisma.user.update({
      where: { email: "scott@example.com" },
      data: { operatorRole: "admin" },
    });

    const informationKey = `request-information-${existingCancellation.reference}`;
    const informationRequest = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${existingCancellation.reference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": informationKey },
      payload: {
        action: "request_information",
        rationale: "Provide the objective notice date and delivery reference.",
      },
    });
    expect(informationRequest.statusCode).toBe(200);
    expect(informationRequest.json()).toEqual(expect.objectContaining({
      status: "information_requested",
      refundedCents: 0,
      lifecycleStatus: "cancellation_review",
    }));
    const informationReplay = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${existingCancellation.reference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": informationKey },
      payload: {
        action: "request_information",
        rationale: "Provide the objective notice date and delivery reference.",
      },
    });
    expect(informationReplay.json()).toEqual(informationRequest.json());

    const partyResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/cancellations/${existingCancellation.reference}/information`,
      headers: { Authorization: `Bearer ${counterpartyToken}`, "Idempotency-Key": "cancellation-info-party-response" },
      payload: { note: "Notice was received on July 30 under delivery record NOTICE-1842." },
    });
    expect(partyResponse.statusCode).toBe(200);
    expect(partyResponse.json().status).toBe("information_received");
    const reviewWithMessages = await server.prisma.cancellationRequest.findUniqueOrThrow({
      where: { reference: existingCancellation.reference },
      include: { reviewMessages: { orderBy: { id: "asc" } } },
    });
    expect(reviewWithMessages.reviewMessages).toEqual([
      expect.objectContaining({ kind: "request_information", authorRole: "admin" }),
      expect.objectContaining({ kind: "party_response", authorRole: "party" }),
    ]);
    const healthWithResponse = await server.inject({
      method: "GET",
      url: "/api/operations/health",
      headers: { Authorization: `Bearer ${administrativeOperatorToken}` },
    });
    expect(healthWithResponse.json().details.cancellationReviews).toContainEqual(
      expect.objectContaining({ reference: existingCancellation.reference, status: "information_received" }),
    );

    const missingProcedure = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${existingCancellation.reference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": "missing-procedural-fields" },
      payload: {
        action: "reject_ineligible",
        rationale: "This request belongs in the duplicate-request procedure.",
      },
    });
    expect(missingProcedure.statusCode).toBe(400);
    const rejectionKey = `procedural-rejection-${existingCancellation.reference}`;
    const rejection = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${existingCancellation.reference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": rejectionKey },
      payload: {
        action: "reject_ineligible",
        rationale: "This request duplicates the active cancellation record.",
        reasonCode: "duplicate_request",
        policyReference: "CANCEL-OPS-2.1",
      },
    });
    expect(rejection.statusCode).toBe(200);
    expect(rejection.json()).toEqual(expect.objectContaining({
      status: "rejected_ineligible",
      refundedCents: 0,
      lifecycleStatus: existingCancellation.preReviewLifecycleStatus,
    }));
    const rejectedRecord = await server.prisma.cancellationRequest.findUniqueOrThrow({
      where: { reference: existingCancellation.reference },
      include: { escrow: true },
    });
    expect(rejectedRecord).toEqual(expect.objectContaining({
      proceduralReasonCode: "duplicate_request",
      policyReference: "CANCEL-OPS-2.1",
      respondedById: expect.any(String),
      respondedAt: expect.any(Date),
    }));
    expect(rejectedRecord.escrow).toEqual(expect.objectContaining({
      lifecycleStatus: existingCancellation.preReviewLifecycleStatus,
      stage: existingCancellation.preReviewStage,
      dueDescription: existingCancellation.preReviewDueDescription,
      status: existingCancellation.preReviewEscrowStatus,
    }));
    expect(await server.prisma.escrowLedgerEntry.count({ where: { movementType: "refund" } }))
      .toBe(refundCountBefore);

    expect((await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/topup",
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}`, "Idempotency-Key": "partial-referral-wallet" },
      payload: { amount: 100 },
    })).statusCode).toBe(200);

    const partialCreate = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: {
        Authorization: `Bearer ${invitedCounterpartyToken}`,
        "Idempotency-Key": "create-partial-referral-guard",
      },
      payload: {
        title: "Partial funding referral guard",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        amount: 100,
        fundingMode: "milestone",
        signatureDataUrl: creatorSignature,
        milestones: [{ title: "Partially funded work", amount: 100 }],
      },
    });
    const partialReference = partialCreate.json().reference as string;
    expect((await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${partialReference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    })).statusCode).toBe(200);
    const partialMilestone = await server.prisma.escrowMilestone.findFirstOrThrow({
      where: { escrow: { reference: partialReference } },
    });
    expect((await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${partialReference}/milestones/${partialMilestone.id}/fund`,
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}`, "Idempotency-Key": "partial-referral-funding" },
      payload: { amount: 50 },
    })).statusCode).toBe(200);
    const partialCancellation = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${partialReference}/cancellation/request`,
      headers: { Authorization: `Bearer ${invitedCounterpartyToken}`, "Idempotency-Key": "partial-referral-cancellation" },
      payload: {
        mode: "unilateral",
        reason: "The party requests review before the milestone is fully funded.",
      },
    });
    const partialReferral = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${partialCancellation.json().cancellationId}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": "partial-referral-denied" },
      payload: {
        action: "refer_to_dispute",
        rationale: "Attempt to reserve the partially funded milestone amount.",
        scope: "milestone",
        milestoneId: partialMilestone.id,
        resumeUnselectedFunds: true,
      },
    });
    expect(partialReferral.statusCode).toBe(409);
    expect(await server.prisma.dispute.count({ where: { milestoneId: partialMilestone.id } })).toBe(0);

    const referral = await createFundedCancellation("formal-referral");
    const referralAction = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${referral.cancellationReference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": "formal-referral-action" },
      payload: {
        action: "refer_to_dispute",
        rationale: "Contested entitlement requires evidence and party resolution.",
        scope: "milestone",
        milestoneId: referral.milestoneId,
        resumeUnselectedFunds: true,
      },
    });
    expect(referralAction.statusCode).toBe(200);
    expect(referralAction.json()).toEqual(expect.objectContaining({
      status: "referred_to_dispute",
      refundedCents: 0,
      disputedCents: 10_000,
      disputeId: expect.stringMatching(/^DSP-/),
    }));
    const referredDisputeReference = referralAction.json().disputeId as string;
    const referredRecord = await server.prisma.cancellationRequest.findUniqueOrThrow({
      where: { reference: referral.cancellationReference },
      include: { referredDispute: true, escrow: { include: { milestones: true } } },
    });
    expect(referredRecord.referredDispute).toEqual(expect.objectContaining({
      reference: referredDisputeReference,
      status: "open",
      amountFrozenCents: 10_000,
    }));
    expect(referredRecord.escrow.milestones[0]?.status).toBe("disputed");
    const formalEvidence = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${referredDisputeReference}/evidence`,
      headers: { Authorization: `Bearer ${counterpartyToken}`, "Idempotency-Key": "formal-referral-evidence" },
      payload: { note: "The seller submits the delivery chronology for formal review." },
    });
    expect(formalEvidence.statusCode).toBe(200);
    const arbitration = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${referredDisputeReference}/arbitration`,
      headers: { Authorization: `Bearer ${counterpartyToken}`, "Idempotency-Key": "formal-referral-arbitration" },
    });
    expect(arbitration.statusCode).toBe(200);
    expect(arbitration.json().status).toBe("arbitration_requested");

    const execution = await createFundedCancellation("final-authority");
    const authorityPayload = {
      action: "execute_documented_full_refund",
      rationale: "Execute the exact full refund directed by the retained final order.",
      authorityType: "court_order",
      authorityReference: "COURT-2026-1842",
      authorityEffectiveAt: new Date(Date.now() - 86_400_000).toISOString(),
      authorityDocumentSha256: "a".repeat(64),
      authorizedRefundCents: 10_000,
      authorityVerified: true,
    };
    const buyerBeforeExecution = await server.prisma.user.findUniqueOrThrow({
      where: { email: "jamie.contractor@example.com" },
    });
    const mismatchedAuthority = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${execution.cancellationReference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": "mismatched-final-authority" },
      payload: { ...authorityPayload, authorizedRefundCents: 9_000 },
    });
    expect(mismatchedAuthority.statusCode).toBe(409);
    expect(await server.prisma.escrowLedgerEntry.count({
      where: { businessReference: `documented-cancellation:${execution.cancellationReference}:full-refund` },
    })).toBe(0);
    const executionKey = `final-authority-${execution.cancellationReference}`;
    const executed = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${execution.cancellationReference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": executionKey },
      payload: authorityPayload,
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toEqual(expect.objectContaining({
      status: "executed_documented_full_refund",
      refundedCents: 10_000,
      disputedCents: 0,
      lifecycleStatus: "cancelled",
    }));
    const executionReplay = await server.inject({
      method: "POST",
      url: `/api/operations/cancellations/${execution.cancellationReference}/actions`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}`, "Idempotency-Key": executionKey },
      payload: authorityPayload,
    });
    expect(executionReplay.json()).toEqual(executed.json());
    const buyerAfterExecution = await server.prisma.user.findUniqueOrThrow({
      where: { email: "jamie.contractor@example.com" },
    });
    expect(buyerAfterExecution.walletBalanceCents).toBe(buyerBeforeExecution.walletBalanceCents + 10_000);
    expect(await server.prisma.escrowLedgerEntry.count({
      where: { businessReference: `documented-cancellation:${execution.cancellationReference}:full-refund` },
    })).toBe(1);
    const executedRecord = await server.prisma.cancellationRequest.findUniqueOrThrow({
      where: { reference: execution.cancellationReference },
      include: { escrow: { include: { milestones: true } }, reviewMessages: true },
    });
    expect(executedRecord).toEqual(expect.objectContaining({
      status: "executed_documented_full_refund",
      authorityType: "court_order",
      authorityReference: "COURT-2026-1842",
      authorityDocumentSha256: "a".repeat(64),
      authorityVerifiedAt: expect.any(Date),
      authorizedRefundCents: 10_000,
    }));
    expect(executedRecord.escrow.lifecycleStatus).toBe("cancelled");
    expect(executedRecord.escrow.milestones).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
    expect(executedRecord.reviewMessages).toEqual([
      expect.objectContaining({ kind: "execute_documented_full_refund", authorRole: "admin" }),
    ]);
    expect(await server.prisma.auditEvent.count({
      where: {
        action: "cancellation.administrative_review_action",
        entityId: { in: [existingCancellation.reference, referral.cancellationReference, execution.cancellationReference] },
      },
    })).toBe(4);

    const operationsEscrow = await server.inject({
      method: "GET",
      url: `/api/operations/escrows/${execution.escrowReference}`,
      headers: { Authorization: `Bearer ${administrativeOperatorToken}` },
    });
    expect(operationsEscrow.statusCode).toBe(200);
    expect(operationsEscrow.json()).toEqual(expect.objectContaining({
      currentRole: "admin",
      escrow: expect.objectContaining({
        cancellation: expect.objectContaining({
          status: "executed_documented_full_refund",
          authorityReference: "COURT-2026-1842",
          reviewMessages: [expect.objectContaining({ kind: "execute_documented_full_refund" })],
        }),
      }),
    }));
  });

  it("reconciles every funded escrow against its immutable ledger", async () => {
    const report = await reconcileEscrowLedger(server.prisma);
    expect(report.checkedEscrows).toBeGreaterThan(0);
    expect(report.exceptions).toEqual([]);
  });

  it("promotes only a uniquely stored, size-and-hash verified legacy evidence file", async () => {
    const submission = await server.prisma.milestoneSubmission.findFirstOrThrow({
      where: {
        milestone: {
          escrow: { reference: createdEscrowReference },
        },
      },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const bytes = Buffer.from("Verified pre-provenance milestone evidence.\n", "utf8");
    const objectId = randomUUID();
    const evidence = await server.prisma.milestoneEvidenceReference.create({
      data: {
        submissionId: submission.id,
        objectKey: `milestone-proofs/${objectId}`,
        fileName: "pre-provenance-proof.txt",
        contentType: "text/plain",
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    await writeFile(path.join(proofStorageDir, objectId), bytes);

    const dryRun = await reconcileEvidenceProvenance(server.prisma, { apply: false });
    expect(dryRun.mode).toBe("dry-run");
    expect(dryRun.candidates).toContainEqual(expect.objectContaining({
      kind: "milestone",
      id: evidence.id,
      fileName: evidence.fileName,
    }));
    expect((await server.prisma.milestoneEvidenceReference.findUniqueOrThrow({
      where: { id: evidence.id },
    })).storageStatus).toBe("legacy_metadata");

    const applied = await reconcileEvidenceProvenance(server.prisma, { apply: true });
    expect(applied.mode).toBe("apply");
    expect(applied.promoted).toBe(1);
    expect(applied.candidates).toContainEqual(expect.objectContaining({
      kind: "milestone",
      id: evidence.id,
    }));
    expect((await server.prisma.milestoneEvidenceReference.findUniqueOrThrow({
      where: { id: evidence.id },
    })).storageStatus).toBe("managed");
  });
});
