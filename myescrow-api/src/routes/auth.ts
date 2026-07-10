import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../utils/errors";
import {
  createUser,
  findUserByEmail,
  findUserById,
  normalizeEmail,
  passwordMatches,
  setUserPassword,
  verifyPassword,
} from "../services/userService";
import {
  confirmEmailVerificationCode,
  formatVerificationResponse,
  issueEmailVerification,
} from "../services/emailVerificationService";
import { claimPendingEscrowsForUser } from "../services/dashboardService";
import { sendPasswordResetEmail, sendVerificationEmail } from "../services/emailService";
import {
  confirmPasswordReset,
  formatPasswordResetResponse,
  issuePasswordReset,
} from "../services/passwordResetService";
import { env } from "../config/env";

type SessionUser = {
  id: string;
  name: string;
  email: string;
};

const issueSession = (fastify: FastifyInstance, user: SessionUser) => {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const token = fastify.jwt.sign(
    { userId: user.id, email: user.email },
    { expiresIn: env.authSessionTtlSeconds },
  );

  return {
    token,
    expiresAt: new Date((issuedAtSeconds + env.authSessionTtlSeconds) * 1000).toISOString(),
    user: { id: user.id, name: user.name, email: user.email },
  };
};

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "qwerty123",
  "letmein123",
  "welcome123",
]);

const strongPasswordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters long.")
  .refine((value) => /[A-Z]/.test(value), { message: "Password must include at least one uppercase letter." })
  .refine((value) => /[a-z]/.test(value), { message: "Password must include at least one lowercase letter." })
  .refine((value) => /[0-9]/.test(value), { message: "Password must include at least one number." })
  .refine((value) => /[^A-Za-z0-9]/.test(value), { message: "Password must include at least one symbol." })
  .refine((value) => !COMMON_PASSWORDS.has(value.toLowerCase()), {
    message: "Password is too common. Pick something more unique.",
  });

const signupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().email(),
  password: strongPasswordSchema,
  partyType: z.enum(["individual", "business"]).optional().default("individual"),
  business: z.object({
    legalName: z.string().trim().min(2).max(120),
    representativeTitle: z.string().trim().min(2).max(80),
  }).optional(),
}).superRefine((value, ctx) => {
  if (value.partyType === "business" && !value.business) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["business"],
      message: "Business name and title are required.",
    });
  }
});

const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
});

const resendVerificationSchema = z.object({
  email: z.string().email(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
  password: strongPasswordSchema,
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: strongPasswordSchema,
});

const requireVerification = process.env.AUTH_REQUIRE_EMAIL_VERIFICATION !== "false";

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request) => {
    const body = loginSchema.parse(request.body);
    const user = await findUserByEmail(fastify.prisma, body.email);
    if (!user) {
      throw new AppError("Invalid email or password.", 401);
    }
    if (requireVerification && !user.emailVerified) {
      throw new AppError("Email not verified. Check your inbox to complete signup.", 403);
    }
    await verifyPassword(user, body.password);
    await claimPendingEscrowsForUser(fastify.prisma, user.id);
    return issueSession(fastify, user);
  });

  fastify.post(
    "/api/auth/change-password",
    { preHandler: fastify.authenticate },
    async (request) => {
      const userId = request.user?.userId;
      if (!userId) {
        throw new AppError("Unauthorized", 401);
      }
      const user = await findUserById(fastify.prisma, userId);
      if (!user) {
        throw new AppError("Unauthorized", 401);
      }
      const body = changePasswordSchema.parse(request.body);
      await verifyPassword(user, body.currentPassword, "Current password is incorrect.");
      if (await passwordMatches(user, body.newPassword)) {
        throw new AppError("New password must be different from your current password.", 400);
      }
      await setUserPassword(fastify.prisma, user.id, body.newPassword);
      return { success: true };
    },
  );

  fastify.post("/api/auth/signup", async (request, reply) => {
    const body = signupSchema.parse(request.body);
    const normalizedEmail = normalizeEmail(body.email);
    const user = await createUser(fastify.prisma, {
      name: body.name,
      email: normalizedEmail,
      password: body.password,
      ...(body.partyType === "business" && body.business
        ? { businessProfile: body.business }
        : {}),
    }, { emailVerified: !requireVerification });

    if (!requireVerification) {
      reply.code(201);
      return issueSession(fastify, user);
    }

    const verification = await issueEmailVerification(fastify.prisma, user);
    await sendVerificationEmail({
      to: user.email,
      name: user.name,
      code: verification.code,
      expiresAt: verification.expiresAt,
      logger: fastify.log,
    });

    reply.code(201);
    return formatVerificationResponse(user, verification);
  });

  fastify.post("/api/auth/verify-email", async (request) => {
    if (!requireVerification) {
      throw new AppError("Email verification is disabled.", 400);
    }
    const body = verifyEmailSchema.parse(request.body);
    const user = await confirmEmailVerificationCode(fastify.prisma, body.email, body.code);
    await claimPendingEscrowsForUser(fastify.prisma, user.id);
    return issueSession(fastify, user);
  });

  fastify.post("/api/auth/resend-verification", async (request) => {
    if (!requireVerification) {
      return { verificationRequired: false };
    }
    const body = resendVerificationSchema.parse(request.body);
    const normalizedEmail = normalizeEmail(body.email);
    const user = await findUserByEmail(fastify.prisma, normalizedEmail);
    if (!user) {
      return { verificationRequired: true, email: normalizedEmail };
    }
    if (user.emailVerified) {
      return { verificationRequired: false, email: user.email };
    }
    const verification = await issueEmailVerification(fastify.prisma, user);
    await sendVerificationEmail({
      to: user.email,
      name: user.name,
      code: verification.code,
      expiresAt: verification.expiresAt,
      logger: fastify.log,
    });
    return formatVerificationResponse(user, verification);
  });

  fastify.post("/api/auth/forgot-password", async (request) => {
    const body = forgotPasswordSchema.parse(request.body);
    const normalizedEmail = normalizeEmail(body.email);
    const user = await findUserByEmail(fastify.prisma, normalizedEmail);
    if (!user) {
      return formatPasswordResetResponse(normalizedEmail, null);
    }
    const reset = await issuePasswordReset(fastify.prisma, user);
    await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      code: reset.code,
      expiresAt: reset.expiresAt,
      logger: fastify.log,
    });
    return formatPasswordResetResponse(user.email, reset);
  });

  fastify.post("/api/auth/reset-password", async (request) => {
    const body = resetPasswordSchema.parse(request.body);
    await confirmPasswordReset(fastify.prisma, body.email, body.code, body.password);
    return { success: true };
  });
}
