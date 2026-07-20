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
    businessProfile?: {
      legalName: string;
      representativeTitle: string;
    };
  },
  options?: { emailVerified?: boolean },
): Promise<User> {
  const normalized = normalizeEmail(data.email);
  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    throw new AppError("Email already in use.", 409);
  }
  return prisma.$transaction(async (tx) => {
    const userId = buildUserId(await getNextSequenceValue(tx, "user", 1000));
    const passwordHash = await bcrypt.hash(data.password, 10);
    return tx.user.create({
      data: {
        id: userId,
        name: data.name,
        email: normalized,
        passwordHash,
        emailVerified: options?.emailVerified ?? false,
        ...(data.businessProfile
          ? {
              businessProfile: {
                create: {
                  legalName: data.businessProfile.legalName,
                  representativeTitle: data.businessProfile.representativeTitle,
                  registrationCountry: "",
                  registrationNumber: "",
                  registeredAddress: "",
                },
              },
            }
          : {}),
      },
    });
  });
}

export async function verifyPassword(
  user: User,
  password: string,
  errorMessage = "Invalid email or password.",
) {
  const isMatch = await bcrypt.compare(password, user.passwordHash);
  if (!isMatch) {
    throw new AppError(errorMessage, 401);
  }
}

export async function passwordMatches(user: User, password: string) {
  return bcrypt.compare(password, user.passwordHash);
}

export async function setUserPassword(
  prisma: Pick<PrismaClient, "user">,
  userId: string,
  password: string,
) {
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });
}
