import bcrypt from "bcryptjs";
import type { PrismaClient, User } from "@prisma/client";
import { buildUserId } from "../utils/id";
import { AppError } from "../utils/errors";
import { getNextSequenceValue } from "./sequenceService";

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(prisma: PrismaClient, email: string) {
  return prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
}

export async function findUserById(prisma: PrismaClient, userId: string) {
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function createUser(
  prisma: PrismaClient,
  data: {
    name: string;
    email: string;
    password: string;
  },
  options?: { emailVerified?: boolean },
): Promise<User> {
  const normalized = normalizeEmail(data.email);
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    throw new AppError("Email already in use.", 409);
  }
  const userId = buildUserId(await getNextSequenceValue(prisma, "user", 1000));
  const passwordHash = await bcrypt.hash(data.password, 10);
  return prisma.user.create({
    data: {
      id: userId,
      name: data.name,
      email: normalized,
      passwordHash,
      emailVerified: options?.emailVerified ?? false,
    },
  });
}

export async function adjustWalletBalance(prisma: PrismaClient, userId: string, deltaCents: number) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError("User not found.", 404);
    }
    const nextBalance = user.walletBalanceCents + deltaCents;
    if (nextBalance < 0) {
      throw new AppError("Insufficient wallet balance.", 400);
    }
    return tx.user.update({
      where: { id: userId },
      data: { walletBalanceCents: nextBalance },
    });
  });
}

export async function verifyPassword(user: User, password: string) {
  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new AppError("Invalid email or password.", 401);
  }
}
