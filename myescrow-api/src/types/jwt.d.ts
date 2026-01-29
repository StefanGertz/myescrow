import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: {
      userId: string;
      email: string;
    };
  }
}
