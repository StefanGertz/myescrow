import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../utils/errors";
import { createUser, findUserByEmail, normalizeEmail, verifyPassword } from "../services/userService";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const signupSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
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
