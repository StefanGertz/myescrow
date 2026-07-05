import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const sentEmails: Array<{ from?: string; to?: string; subject?: string; html?: string; text?: string }> = [];

beforeAll(async () => {
  schemaName = `vitest_${Date.now()}`;
  const baseUrl = process.env.DATABASE_URL ?? "postgresql://myescrow:myescrow@localhost:5432/myescrow";
  process.env.DATABASE_URL = `${baseUrl}?schema=${schemaName}`;
  process.env.JWT_SECRET = "test-secret";
  process.env.AUTH_SESSION_TTL_SECONDS = "28800";
  process.env.PORT = "0";
  process.env.NODE_ENV = "test";
  process.env.RESEND_API_KEY = "test-resend-key";
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
  delete process.env.RESEND_API_KEY;
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
    const payload = {
      title: "New project escrow",
      counterpartyEmail: "nora@example.com",
      creatorRole: "buyer",
      creatorParty: {
        type: "business",
        business: {
          legalName: "Scott Holdings Inc.",
          registrationCountry: "Canada",
          registrationNumber: "CA-12345",
          registeredAddress: "100 King Street, Toronto, ON",
          representativeTitle: "Director",
        },
      },
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
    expect(response.json().counterpart).toBe("Nora Studio");
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.reference).toMatch(/^PO-/);
    createdEscrowReference = body.reference;
    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const createdEscrow = escrowsResponse.json().escrows.find((item: any) => item.id === createdEscrowReference);
    expect(createdEscrow.buyer).toEqual(expect.objectContaining({
      name: "Scott Holdings Inc.",
      partyType: "business",
      representativeName: "Scott",
      representativeTitle: "Director",
      registrationNumber: "CA-12345",
    }));
    const businessProfileResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/business-profile",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(businessProfileResponse.statusCode).toBe(200);
    expect(businessProfileResponse.json().businessProfile).toEqual(expect.objectContaining({
      legalName: "Scott Holdings Inc.",
      registrationNumber: "CA-12345",
      representativeTitle: "Director",
    }));
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
    expect(revisedEscrow.lifecycleStatus).toBe("pending_approval");
    expect(revisedEscrow.amount).toBe("$1,625.00");
    expect(revisedEscrow.milestones[0]).toEqual(
      expect.objectContaining({
        title: "Creator-reviewed deposit wording",
        amount: "$625.00",
        deadline: "2026-08-20T00:00:00.000Z",
      }),
    );

    const retainedMilestone = revisedEscrow.milestones[1];
    const secondRequestResponse = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${createdEscrowReference}/milestones/${retainedMilestone.id}/request-changes`,
      headers: { Authorization: `Bearer ${counterpartyToken}` },
      payload: { title: "Changed handoff", amount: 900, note: "Reduce this payment." },
    });
    expect(secondRequestResponse.statusCode).toBe(200);

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
  });

  it("creates an escrow for a counterparty who has not signed up yet", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/dashboard/escrows/create",
      headers: { Authorization: `Bearer ${token}` },
      payload: {
        title: "Invite-first escrow",
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
    expect(invitedEscrow.counterpart).toBe("jamie.contractor@example.com");
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
            registrationCountry: "Canada",
            registrationNumber: "ON-7788",
            registeredAddress: "200 Queen Street, Toronto, ON",
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

  it("records wallet withdrawals as debits", async () => {
    const withdrawResponse = await server.inject({
      method: "POST",
      url: "/api/dashboard/wallet/withdraw",
      headers: { Authorization: `Bearer ${token}` },
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
