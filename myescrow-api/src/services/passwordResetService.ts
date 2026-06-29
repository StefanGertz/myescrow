import crypto from "crypto";
import type { PrismaClient, User } from "@prisma/client";
import { AppError } from "../utils/errors";
import { normalizeEmail, setUserPassword } from "./userService";

const CODE_DIGITS = Number(process.env.PASSWORD_RESET_CODE_DIGITS ?? "6");
const EXPIRATION_MINUTES = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? "15");
const DEBUG_CODES_ENABLED =
  process.env.AUTH_DEBUG_CODES === "true" || process.env.NODE_ENV !== "production";

const hashValue = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

const generateCode = () =>
  crypto.randomInt(0, 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, "0");

export async function issuePasswordReset(
  prisma: PrismaClient,
  user: User,
): Promise<{ code: string; expiresAt: Date }> {
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  const code = generateCode();
  const expiresAt = new Date(Date.now() + EXPIRATION_MINUTES * 60 * 1000);
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      codeHash: hashValue(code),
      expiresAt,
    },
  });
  return { code, expiresAt };
}

export async function confirmPasswordReset(
  prisma: PrismaClient,
  email: string,
  code: string,
  password: string,
) {
  const normalizedEmail = normalizeEmail(email);
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    throw new AppError("Invalid or expired reset code.", 400);
  }
  const token = await prisma.passwordResetToken.findFirst({
    where: {
      userId: user.id,
      codeHash: hashValue(code),
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!token) {
    throw new AppError("Invalid or expired reset code.", 400);
  }
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.update({
      where: { id: token.id },
      data: { consumedAt: new Date() },
    });
    await setUserPassword(tx, user.id, password);
  });
}

export function formatPasswordResetResponse(
  email: string,
  reset: { code: string; expiresAt: Date } | null,
) {
  return {
    accepted: true,
    email,
    expiresAt: reset?.expiresAt.toISOString(),
    debugCode: DEBUG_CODES_ENABLED ? reset?.code : undefined,
  };
}
