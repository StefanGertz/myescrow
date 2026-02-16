import type { FastifyBaseLogger } from "fastify";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "MyEscrow <no-reply@myescrow.local>";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

type VerificationEmailPayload = {
  to: string;
  name: string;
  code: string;
  expiresAt: Date;
  logger: FastifyBaseLogger;
};

const buildEmailHtml = (code: string, expiresAt: Date) => {
  const formattedExpiry = expiresAt.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
  const link = `${APP_URL.replace(/\/$/, "")}/verify-email`;
  return `
    <p>Hi there,</p>
    <p>Your MyEscrow verification code is <strong style="font-size: 20px;">${code}</strong>.</p>
    <p>Enter this code on the verification page within the next 15 minutes (${formattedExpiry}).</p>
    <p>You can also open <a href="${link}">${link}</a> and paste the code there.</p>
    <p>If you didn't request this, you can ignore the email.</p>
  `;
};

const buildEmailText = (code: string, expiresAt: Date) => {
  const link = `${APP_URL.replace(/\/$/, "")}/verify-email`;
  return [
    `Your MyEscrow verification code is ${code}.`,
    `Enter this code within 15 minutes.`,
    `Verification page: ${link}`,
    "",
    "If you didn't request this code, you can ignore the email.",
  ].join("\n");
};

export async function sendVerificationEmail({
  to,
  name,
  code,
  expiresAt,
  logger,
}: VerificationEmailPayload) {
  const previewMessage = `Verification code for ${to}: ${code}`;
  logger.info({ to, code }, "Email verification code issued");

  if (!RESEND_API_KEY) {
    logger.warn(
      { to },
      "RESEND_API_KEY not set; verification email not sent externally. Code logged for development only.",
    );
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to,
      subject: "Verify your MyEscrow account",
      html: buildEmailHtml(code, expiresAt),
      text: buildEmailText(code, expiresAt),
      reply_to: EMAIL_FROM,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error({ to, text }, "Failed to send verification email via Resend");
    throw new Error("Failed to send verification email.");
  }
}
