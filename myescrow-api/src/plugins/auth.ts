import fp from "fastify-plugin";
import fastifyJwt from "@fastify/jwt";
import { env } from "../config/env";
import { AppError } from "../utils/errors";

export const authPlugin = fp(async (fastify) => {
  fastify.register(fastifyJwt, {
    secret: env.jwtSecret,
  });

  fastify.decorate("authenticate", async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new AppError("Unauthorized", 401);
    }
  });
});
