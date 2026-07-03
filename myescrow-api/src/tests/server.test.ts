import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "path";
import type { FastifyInstance } from "fastify";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

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
let invitedSignupEscrowReference: string;
let invitedCounterpartyToken: string;

beforeAll(async () => {
  schemaName = `vitest_${Date.now()}`;
  const baseUrl = process.env.DATABASE_URL ?? "postgresql://myescrow:myescrow@localhost:5432/myescrow";
  process.env.DATABASE_URL = `${baseUrl}?schema=${schemaName}`;
  process.env.JWT_SECRET = "test-secret";
  process.env.AUTH_SESSION_TTL_SECONDS = "28800";
  process.env.PORT = "0";
  process.env.NODE_ENV = "test";
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
});

describe("MyEscrow API", () => {
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
    const payload = server.jwt.decode<{ iat: number; exp: number }>(token);
    expect(payload).not.toBeNull();
    if (!payload) throw new Error("Expected a decodable session token");
    expect(payload.exp - payload.iat).toBe(28_800);
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
    const payload = {
      title: "New project escrow",
      counterpart: "Nora Studio",
      counterpartyEmail: "nora@example.com",
      creatorRole: "buyer",
      amount: 1500,
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
      headers: { Authorization: `Bearer ${token}` },
      payload,
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.reference).toMatch(/^PO-/);
    createdEscrowReference = body.reference;
  });

  it("supports milestone change requests before escrow approval", async () => {
    const counterpartyEscrows = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    const escrow = counterpartyEscrows.json().escrows.find((item: any) => item.id === createdEscrowReference);
    const milestoneId = escrow.milestones[0].id;
    expect(escrow.milestones[0].deadline).toBe("2026-08-01T00:00:00.000Z");

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

    const ownerBeforeApply = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const requestedEscrow = ownerBeforeApply.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(requestedEscrow.lifecycleStatus).toBe("changes_requested");
    expect(requestedEscrow.milestones[0].requestedTitle).toBe("Revised deposit wording");

    const applyResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${milestoneId}/apply-changes`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(applyResponse.statusCode).toBe(200);

    const counterpartyAfterApply = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${counterpartyToken}` },
    });
    const revisedEscrow = counterpartyAfterApply.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(revisedEscrow.lifecycleStatus).toBe("pending_approval");
    expect(revisedEscrow.amount).toBe("$1,600.00");
    expect(revisedEscrow.milestones[0]).toEqual(
      expect.objectContaining({
        title: "Revised deposit wording",
        amount: "$600.00",
        deadline: "2026-08-15T00:00:00.000Z",
      }),
    );
  });

  it("creates an escrow for a counterparty who has not signed up yet", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        title: "Invite-first escrow",
        counterpart: "Jamie Contractor",
        counterpartyEmail: "jamie.contractor@example.com",
        creatorRole: "buyer",
        amount: 750,
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
  });

  it("claims the pending escrow after the invited counterparty signs up and verifies", async () => {
    const signupResponse = await server.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        name: "Jamie Contractor",
        email: "jamie.contractor@example.com",
        password: "InviteFlowPass123!",
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

    const ownerEscrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const ownerEscrow = ownerEscrowsResponse
      .json()
      .escrows.find((escrow: any) => escrow.id === invitedSignupEscrowReference);
    expect(ownerEscrow.lifecycleStatus).toBe("pending_approval");

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
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });

  it("approves the escrow as the counterparty", async () => {
    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/approve`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { signatureDataUrl: counterpartySignature },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });

  it("funds the escrow as the buyer", async () => {
    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/fund`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
  });

  it("releases a single milestone from the funded escrow", async () => {
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

    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${createdMilestoneId}/approve`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
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
    expect(targetEscrow.milestones[1].status).toBe("pending");
  });

  it("creates another funded escrow for rejection and resubmission checks", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        title: "Revision workflow escrow",
        counterpart: "Nora Studio",
        counterpartyEmail: "nora@example.com",
        creatorRole: "buyer",
        amount: 900,
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
    });
    expect(approveResponse.statusCode).toBe(200);

    const fundResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/fund`,
      headers: { Authorization: `Bearer ${token}` },
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

    const rejectResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/reject`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(rejectResponse.statusCode).toBe(200);

    const sellerResubmitResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${secondMilestoneEscrowReference}/milestones/${rejectedMilestoneId}/resubmit`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
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
    expect(refreshedEscrow.milestones[0].status).toBe("pending");
  });

  it("tops up the wallet", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/topup",
      headers: { Authorization: `Bearer ${token}` },
      payload: { amount: 2500 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().balance).toBeGreaterThan(0);
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

  it("resolves a dispute", async () => {
    const responseDisputes = await server.inject({
      method: "GET",
      url: "/api/dashboard/disputes",
      headers: { Authorization: `Bearer ${token}` },
    });
    const disputes = responseDisputes.json();
    const target = disputes.disputes[0];
    expect(target).toBeDefined();
    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/disputes/${target.id}/resolve`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().disputeId).toBe(target.id);
  });
});
