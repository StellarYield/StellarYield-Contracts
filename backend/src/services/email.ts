import nodemailer from "nodemailer";
import { config } from "../config.js";
import { logger } from "../logger.js";

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  if (!config.smtp.host || !config.smtp.port || !config.smtp.user || !config.smtp.pass || !config.smtp.from) {
    return null;
  }

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });

  return transporter;
}

// Deliberately simple: rejects obvious malformed input (missing "@", no dot in
// the domain, whitespace) before it reaches the SMTP server. It is not a full
// RFC 5322 parser.
const RECIPIENT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidRecipient(address: string): boolean {
  return RECIPIENT_PATTERN.test(address);
}

/**
 * Send a transactional email.
 *
 * - Throws `TypeError` if `to` is not a valid address. This is checked before
 *   any SMTP call, so a bad recipient never reaches the transport.
 * - Transport failures are logged and swallowed. A notification worker must
 *   not crash because the mail server is unavailable.
 * - Does nothing (debug log only) when SMTP is not configured.
 */
export async function sendEmail(options: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  if (!isValidRecipient(options.to)) {
    throw new TypeError(`Invalid recipient address: ${options.to}`);
  }

  const transport = getTransporter();
  if (!transport) {
    logger.debug({ to: options.to }, "SMTP not configured, skipping email");
    return;
  }

  try {
    await transport.sendMail({
      from: config.smtp.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
    });
    logger.info({ to: options.to }, "Email sent successfully");
  } catch (err) {
    logger.error({ to: options.to, err }, "Failed to send email");
  }
}