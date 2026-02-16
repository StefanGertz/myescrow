import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../utils/errors";
import { createUser, findUserByEmail, normalizeEmail, verifyPassword } from "../services/userService";
import {
  confirmEmailVerificationCode,
  formatVerificationResponse,
  issueEmailVerification,
} from "../services/emailVerificationService";
import { sendVerificationEmail } from "../services/emailService";

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
});

const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().min(6).max(8),
});

const resendVerificationSchema = z.object({
  email: z.string().email(),
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
    const token = fastify.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, name: user.name, email: user.email } };
  });

  fastify.post("/api/auth/signup", async (request, reply) => {
    const body = signupSchema.parse(request.body);
    const normalizedEmail = normalizeEmail(body.email);
    const user = await createUser(fastify.prisma, {
      name: body.name,
      email: normalizedEmail,
      password: body.password,
    }, { emailVerified: !requireVerification });

    if (!requireVerification) {
      const token = fastify.jwt.sign({ userId: user.id, email: user.email });
      reply.code(201);
      return { token, user: { id: user.id, name: user.name, email: user.email } };
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
    const token = fastify.jwt.sign({ userId: user.id, email: user.email });
    return { token, user: { id: user.id, name: user.name, email: user.email } };
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
}
