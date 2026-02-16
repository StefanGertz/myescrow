import crypto from "crypto";
import type { PrismaClient, User } from "@prisma/client";
import { AppError } from "../utils/errors";
import { normalizeEmail } from "./userService";

const CODE_DIGITS = Number(process.env.EMAIL_VERIFICATION_CODE_DIGITS ?? "6");
const EXPIRATION_MINUTES = Number(process.env.EMAIL_VERIFICATION_TTL_MINUTES ?? "15");
const DEBUG_CODES_ENABLED = process.env.AUTH_DEBUG_CODES === "true";

const hashValue = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

const generateCode = () =>
  crypto.randomInt(0, 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, "0");

export async function issueEmailVerification(
  prisma: PrismaClient,
  user: User,
): Promise<{ code: string; expiresAt: Date }> {
  await prisma.emailVerificationToken.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRATION_MINUTES * 60 * 1000);
  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      codeHash: hashValue(code),
      expiresAt,
    },
  });
  return { code, expiresAt };
}

export async function confirmEmailVerificationCode(
  prisma: PrismaClient,
  email: string,
  code: string,
) {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    throw new AppError("Invalid verification code.", 400);
  }
  const hashed = hashValue(code);
  const token = await prisma.emailVerificationToken.findFirst({
    where: {
      userId: user.id,
      codeHash: hashed,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!token) {
    throw new AppError("Invalid or expired verification code.", 400);
  }
  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true },
    }),
  ]);
  return await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
}

export function formatVerificationResponse(
  user: User,
  verification: { code: string; expiresAt: Date },
) {
  return {
    verificationRequired: true,
    email: user.email,
    expiresAt: verification.expiresAt.toISOString(),
    debugCode: DEBUG_CODES_ENABLED ? verification.code : undefined,
  };
}
