import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { env } from "./config/env";
import { authPlugin } from "./plugins/auth";
import { prismaPlugin } from "./plugins/prisma";
import { authRoutes } from "./routes/auth";
import { dashboardRoutes } from "./routes/dashboard";
import { AppError } from "./utils/errors";

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: env.nodeEnv === "production" ? "info" : "debug",
    },
  });

  await fastify.register(cors, { origin: true });
  await fastify.register(prismaPlugin);
  await fastify.register(authPlugin);
  await fastify.register(authRoutes);
  await fastify.register(dashboardRoutes);

  fastify.get("/", async () => {
    return { status: "ok" };
  });

  fastify.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: "Invalid request payload.",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
      return;
    }
    fastify.log.error(error);
    reply.status(500).send({ error: "Internal server error" });
  });

  return fastify;
}

async function start() {
  const server = await buildServer();
  await server.listen({ port: env.port, host: "0.0.0.0" });
  server.log.info(`Server ready on http://localhost:${env.port}`);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
