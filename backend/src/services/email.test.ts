import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const CONFIGURED_SMTP = {
    host: "smtp.example.test",
    port: 587,
    user: "mailer",
    pass: "secret",
    from: "noreply@example.test",
  };
  return {
    CONFIGURED_SMTP,
    // Mutated per test. The config mock below holds this same object.
    smtp: { ...CONFIGURED_SMTP } as Record<string, unknown>,
    sendMail: vi.fn(),
    createTransport: vi.fn(),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));
vi.mock("../config.js", () => ({ config: { smtp: mocks.smtp } }));
vi.mock("../logger.js", () => ({ logger: mocks.logger }));

const MESSAGE = {
  to: "investor@example.com",
  subject: "StellarYield Event: yield_distributed",
  html: "<p>Yield distributed</p>",
};

/**
 * email.ts caches its transporter in module state. Reloading the module gives
 * each test a fresh cache, so a test that needs "SMTP not configured" is not
 * affected by an earlier test that created a transporter.
 */
async function loadEmail(): Promise<typeof import("./email.js")> {
  vi.resetModules();
  return import("./email.js");
}

describe("sendEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.smtp, mocks.CONFIGURED_SMTP);
    mocks.createTransport.mockReturnValue({ sendMail: mocks.sendMail });
    mocks.sendMail.mockResolvedValue({ messageId: "test-message" });
  });

  describe("delivery", () => {
    it("sends through the configured SMTP transport", async () => {
      const { sendEmail } = await loadEmail();

      await sendEmail(MESSAGE);

      expect(mocks.createTransport).toHaveBeenCalledWith({
        host: "smtp.example.test",
        port: 587,
        auth: { user: "mailer", pass: "secret" },
      });
      expect(mocks.sendMail).toHaveBeenCalledWith({
        from: "noreply@example.test",
        to: "investor@example.com",
        subject: MESSAGE.subject,
        html: MESSAGE.html,
      });
      expect(mocks.logger.info).toHaveBeenCalledWith(
        { to: "investor@example.com" },
        "Email sent successfully",
      );
    });

    it("does nothing when SMTP is not configured", async () => {
      mocks.smtp.host = undefined;
      const { sendEmail } = await loadEmail();

      await expect(sendEmail(MESSAGE)).resolves.toBeUndefined();

      expect(mocks.createTransport).not.toHaveBeenCalled();
      expect(mocks.sendMail).not.toHaveBeenCalled();
      expect(mocks.logger.debug).toHaveBeenCalledWith(
        { to: "investor@example.com" },
        "SMTP not configured, skipping email",
      );
    });
  });

  describe("transport failure", () => {
    it("logs the error and does not throw to the caller", async () => {
      mocks.sendMail.mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:587"));
      const { sendEmail } = await loadEmail();

      await expect(sendEmail(MESSAGE)).resolves.toBeUndefined();

      expect(mocks.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "investor@example.com",
          err: expect.objectContaining({ message: "ECONNREFUSED 127.0.0.1:587" }),
        }),
        "Failed to send email",
      );
    });
  });

  describe("recipient validation", () => {
    it.each([
      "",
      "no-at-sign.example.com",
      "missing-domain@",
      "@missing-local.example.com",
      "no-dot-in-domain@localhost",
      "two words@example.com",
      "double@@example.com",
    ])("rejects malformed recipient %j before contacting the transport", async (to) => {
      const { sendEmail } = await loadEmail();

      await expect(sendEmail({ ...MESSAGE, to })).rejects.toThrow(TypeError);

      expect(mocks.createTransport).not.toHaveBeenCalled();
      expect(mocks.sendMail).not.toHaveBeenCalled();
    });

    it("rejects an invalid recipient even when SMTP is not configured", async () => {
      mocks.smtp.host = undefined;
      const { sendEmail } = await loadEmail();

      await expect(sendEmail({ ...MESSAGE, to: "not-an-address" })).rejects.toThrow(
        "Invalid recipient address: not-an-address",
      );
    });

    it.each(["investor@example.com", "first.last+tag@sub.example.co"])(
      "accepts well-formed recipient %s",
      async (to) => {
        const { sendEmail, isValidRecipient } = await loadEmail();

        expect(isValidRecipient(to)).toBe(true);
        await sendEmail({ ...MESSAGE, to });

        expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to }));
      },
    );
  });
});
