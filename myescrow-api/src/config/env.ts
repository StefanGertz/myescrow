import "dotenv/config";

const port = Number(process.env.PORT ?? 4000);
const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";
const authSessionTtlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS ?? 8 * 60 * 60);

if (!jwtSecret) {
  throw new Error("JWT_SECRET is required");
}

if (!Number.isInteger(authSessionTtlSeconds) || authSessionTtlSeconds <= 0) {
  throw new Error("AUTH_SESSION_TTL_SECONDS must be a positive integer");
}

export const env = {
  port: Number.isFinite(port) ? port : 4000,
  jwtSecret,
  authSessionTtlSeconds,
  nodeEnv: process.env.NODE_ENV ?? "development",
};
