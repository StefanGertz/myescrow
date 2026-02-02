import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../utils/errors";
import { createUser, findUserByEmail, normalizeEmail, verifyPassword } from "../services/userService";

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

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/api/auth/login", async (request) => {
    const body = loginSchema.parse(request.body);
    const user = await findUserByEmail(fastify.prisma, body.email);
    if (!user) {
      throw new AppError("Invalid email or password.", 401);
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
    });
    const token = fastify.jwt.sign({ userId: user.id, email: user.email });
    reply.code(201);
    return { token, user: { id: user.id, name: user.name, email: user.email } };
  });
}
