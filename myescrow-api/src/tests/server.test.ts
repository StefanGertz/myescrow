import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "path";
import type { FastifyInstance } from "fastify";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

let server: FastifyInstance;
let token: string;
let schemaName: string;
const defaultPassword = "password123";

beforeAll(async () => {
  schemaName = `vitest_${Date.now()}`;
  const baseUrl = process.env.DATABASE_URL ?? "postgresql://myescrow:myescrow@localhost:5432/myescrow";
  process.env.DATABASE_URL = `${baseUrl}?schema=${schemaName}`;
  process.env.JWT_SECRET = "test-secret";
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

  it("creates a new escrow", async () => {
    const payload = {
      title: "New milestone",
      counterpart: "Acme Builders",
      amount: 15000,
      category: "Construction",
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
  });

  it("releases an escrow", async () => {
    const escrowsResponse = await server.inject({
      method: "GET",
      url: "/api/dashboard/escrows",
      headers: { Authorization: `Bearer ${token}` },
    });
    const escrows = escrowsResponse.json();
    const releasable = escrows.escrows.find((escrow: any) => escrow.counterpartyApproved);
    expect(releasable).toBeDefined();
    const response = await server.inject({
      method: "POST",
      url: `/api/dashboard/escrows/${releasable.id}/release`,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
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
