import "dotenv/config";

const port = Number(process.env.PORT ?? 4000);
const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";

if (!jwtSecret) {
  throw new Error("JWT_SECRET is required");
}

export const env = {
  port: Number.isFinite(port) ? port : 4000,
  jwtSecret,
  nodeEnv: process.env.NODE_ENV ?? "development",
};
