import type { FastifyBaseLogger } from "fastify";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "MyEscrow <hello@myescrow.local>";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

type ResendEmailPayload = {
  to: string;
  subject: string;
  html: string;
  text: string;
  category: "verification" | "password_reset" | "escrow_invitation" | "milestone_change_request";
  logger: FastifyBaseLogger;
};

async function sendResendEmail({
  to,
  subject,
  html,
  text,
  category,
  logger,
}: ResendEmailPayload) {
  const startedAt = Date.now();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to,
      subject,
      html,
      text,
      ...(EMAIL_REPLY_TO ? { reply_to: EMAIL_REPLY_TO } : {}),
    }),
  });

  if (!response.ok) {
    const responseText = await response.text();
    logger.error(
      { to, category, statusCode: response.status, responseText },
      "Failed to send email via Resend",
    );
    throw new Error(`Failed to send ${category.replaceAll("_", " ")} email.`);
  }

  const result = await response.json().catch(() => null) as { id?: string } | null;
  logger.info(
    { to, category, emailId: result?.id, acceptedInMs: Date.now() - startedAt },
    "Email accepted by Resend",
  );
}

type VerificationEmailPayload = {
  to: string;
  name: string;
  code: string;
  expiresAt: Date;
  logger: FastifyBaseLogger;
};

type PasswordResetEmailPayload = VerificationEmailPayload;
type EscrowInvitationEmailPayload = {
  to: string;
  recipientName: string;
  creatorName: string;
  escrowTitle: string;
  escrowReference: string;
  creatorRole: "buyer" | "seller";
  invitationStatus: "existing_user" | "signup_required" | "verification_required";
  logger: FastifyBaseLogger;
};

type MilestoneChangeRequestEmailPayload = {
  to: string;
  recipientName: string;
  requesterName: string;
  escrowTitle: string;
  escrowReference: string;
  milestoneTitle: string;
  note?: string | undefined;
  logger: FastifyBaseLogger;
};

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

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

  await sendResendEmail({
    to,
    subject: `Your MyEscrow verification code: ${code}`,
    html: buildEmailHtml(code, expiresAt),
    text: buildEmailText(code, expiresAt),
    category: "verification",
    logger,
  });
}

const buildResetEmailHtml = (code: string, expiresAt: Date) => {
  const formattedExpiry = expiresAt.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
  const link = `${APP_URL.replace(/\/$/, "")}/reset-password`;
  return `
    <p>Hi there,</p>
    <p>Your MyEscrow password reset code is <strong style="font-size: 20px;">${code}</strong>.</p>
    <p>Enter this code on the password reset page within the next 15 minutes (${formattedExpiry}).</p>
    <p>You can also open <a href="${link}">${link}</a> and paste the code there.</p>
    <p>If you didn't request this, you can ignore the email.</p>
  `;
};

const buildResetEmailText = (code: string) => {
  const link = `${APP_URL.replace(/\/$/, "")}/reset-password`;
  return [
    `Your MyEscrow password reset code is ${code}.`,
    "Enter this code within 15 minutes.",
    `Reset page: ${link}`,
    "",
    "If you didn't request this code, you can ignore the email.",
  ].join("\n");
};

export async function sendPasswordResetEmail({
  to,
  code,
  expiresAt,
  logger,
}: PasswordResetEmailPayload) {
  logger.info({ to, code }, "Password reset code issued");

  if (!RESEND_API_KEY) {
    logger.warn(
      { to },
      "RESEND_API_KEY not set; password reset email not sent externally. Code logged for development only.",
    );
    return;
  }

  await sendResendEmail({
    to,
    subject: `Your MyEscrow password reset code: ${code}`,
    html: buildResetEmailHtml(code, expiresAt),
    text: buildResetEmailText(code),
    category: "password_reset",
    logger,
  });
}

const buildEscrowInvitationHtml = ({
  creatorName,
  escrowTitle,
  escrowReference,
  creatorRole,
  invitationStatus,
  to,
}: Pick<EscrowInvitationEmailPayload, "creatorName" | "escrowTitle" | "escrowReference" | "creatorRole" | "invitationStatus" | "to">) => {
  const baseUrl = APP_URL.replace(/\/$/, "");
  const signupParams = new URLSearchParams({ email: to, invite: escrowReference });
  const verifyParams = new URLSearchParams({ email: to, invite: escrowReference });
  const dashboardLink = `${baseUrl}/?screen=dashboard`;
  const signupLink = `${baseUrl}/signup?${signupParams.toString()}`;
  const verifyLink = `${baseUrl}/verify-email?${verifyParams.toString()}`;
  const roleText = creatorRole === "buyer" ? "buyer" : "seller";
  const action = invitationStatus === "existing_user"
    ? {
        sentence: "Sign in to MyEscrow to review the agreement and approve or reject it.",
        link: dashboardLink,
        label: "Open MyEscrow",
      }
    : invitationStatus === "verification_required"
      ? {
          sentence: "Verify your MyEscrow email, then sign in to review the agreement.",
          link: verifyLink,
          label: "Verify your email",
        }
      : {
          sentence: "Create your MyEscrow account to review the agreement and continue onboarding.",
          link: signupLink,
          label: "Create your account",
        };
  return `
    <p>Hi there,</p>
    <p><strong>${creatorName}</strong> invited you to join the escrow <strong>${escrowTitle}</strong> (${escrowReference}) as the ${roleText === "buyer" ? "seller" : "buyer"}.</p>
    <p>${action.sentence}</p>
    <p><a href="${action.link}">${action.label}</a></p>
  `;
};

const buildEscrowInvitationText = ({
  creatorName,
  escrowTitle,
  escrowReference,
  creatorRole,
  invitationStatus,
  to,
}: Pick<EscrowInvitationEmailPayload, "creatorName" | "escrowTitle" | "escrowReference" | "creatorRole" | "invitationStatus" | "to">) => {
  const baseUrl = APP_URL.replace(/\/$/, "");
  const signupParams = new URLSearchParams({ email: to, invite: escrowReference });
  const verifyParams = new URLSearchParams({ email: to, invite: escrowReference });
  const link = invitationStatus === "existing_user"
    ? `${baseUrl}/?screen=dashboard`
    : invitationStatus === "verification_required"
      ? `${baseUrl}/verify-email?${verifyParams.toString()}`
      : `${baseUrl}/signup?${signupParams.toString()}`;
  const invitedRole = creatorRole === "buyer" ? "seller" : "buyer";
  const actionLine = invitationStatus === "existing_user"
    ? "Sign in to review the agreement and approve or reject it."
    : invitationStatus === "verification_required"
      ? "Verify your email, then sign in to review the agreement."
      : "Create your account to review the agreement and continue onboarding.";
  return [
    `${creatorName} invited you to join the escrow "${escrowTitle}" (${escrowReference}) as the ${invitedRole}.`,
    actionLine,
    `Open MyEscrow: ${link}`,
  ].join("\n");
};

export async function sendEscrowInvitationEmail(payload: EscrowInvitationEmailPayload) {
  const {
    to,
    recipientName: _recipientName,
    creatorName,
    escrowTitle,
    escrowReference,
    creatorRole,
    invitationStatus,
    logger,
  } = payload;

  logger.info({ to, escrowReference }, "Escrow invitation issued");

  if (!RESEND_API_KEY) {
    logger.warn(
      { to, escrowReference },
      "RESEND_API_KEY not set; escrow invitation email not sent externally.",
    );
    return;
  }

  await sendResendEmail({
    to,
    subject: `Review escrow ${escrowReference} on MyEscrow`,
    html: buildEscrowInvitationHtml({
      creatorName,
      escrowTitle,
      escrowReference,
      creatorRole,
      invitationStatus,
      to,
    }),
    text: buildEscrowInvitationText({
      creatorName,
      escrowTitle,
      escrowReference,
      creatorRole,
      invitationStatus,
      to,
    }),
    category: "escrow_invitation",
    logger,
  });
}

export async function sendMilestoneChangeRequestEmail({
  to,
  recipientName,
  requesterName,
  escrowTitle,
  escrowReference,
  milestoneTitle,
  note,
  logger,
}: MilestoneChangeRequestEmailPayload): Promise<"sent" | "skipped"> {
  logger.info({ to, escrowReference, milestoneTitle }, "Milestone change request email issued");

  if (!RESEND_API_KEY) {
    logger.warn(
      { to, escrowReference, milestoneTitle },
      "RESEND_API_KEY not set; milestone change request email not sent externally.",
    );
    return "skipped";
  }

  const transactionLink = `${APP_URL.replace(/\/$/, "")}/?screen=transaction&tx=${encodeURIComponent(escrowReference)}`;
  const safeRecipientName = escapeHtml(recipientName);
  const safeRequesterName = escapeHtml(requesterName);
  const safeEscrowTitle = escapeHtml(escrowTitle);
  const safeEscrowReference = escapeHtml(escrowReference);
  const safeMilestoneTitle = escapeHtml(milestoneTitle);
  const safeNote = note ? escapeHtml(note) : null;

  await sendResendEmail({
    to,
    subject: `${requesterName} requested changes to ${escrowReference}`,
    html: `
      <p>Hi ${safeRecipientName},</p>
      <p><strong>${safeRequesterName}</strong> requested changes to the milestone <strong>${safeMilestoneTitle}</strong> in <strong>${safeEscrowTitle}</strong> (${safeEscrowReference}).</p>
      ${safeNote ? `<p><strong>Note:</strong> ${safeNote}</p>` : ""}
      <p>Review the original and proposed terms, edit them if needed, then accept the changes or keep the original milestone.</p>
      <p><a href="${transactionLink}">Review requested changes</a></p>
    `,
    text: [
      `Hi ${recipientName},`,
      `${requesterName} requested changes to the milestone "${milestoneTitle}" in "${escrowTitle}" (${escrowReference}).`,
      ...(note ? [`Note: ${note}`] : []),
      "Review the original and proposed terms, edit them if needed, then accept the changes or keep the original milestone.",
      `Review requested changes: ${transactionLink}`,
    ].join("\n\n"),
    category: "milestone_change_request",
    logger,
  });

  return "sent";
}
