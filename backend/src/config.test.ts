import { describe, it, expect } from "vitest";
import { config, envSchema } from "./config.js";

describe("config", () => {
  const baseValidEnv = {
    PORT: "3000",
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/stellaryield",
  };

  it("has a positive port number", () => {
    expect(config.port).toBeGreaterThan(0);
  });

  describe("ARCHIVE_CRON", () => {
    it("defaults to 2am daily ('0 2 * * *')", () => {
      expect(config.archiveCron).toBe("0 2 * * *");
      const parsed = envSchema.safeParse(baseValidEnv);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ARCHIVE_CRON).toBe("0 2 * * *");
      }
    });

    it("accepts valid cron expressions such as '0 3 * * *'", () => {
      const parsed = envSchema.safeParse({
        ...baseValidEnv,
        ARCHIVE_CRON: "0 3 * * *",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ARCHIVE_CRON).toBe("0 3 * * *");
      }
    });

    it("accepts interval cron expressions such as '*/15 * * * *'", () => {
      const parsed = envSchema.safeParse({
        ...baseValidEnv,
        ARCHIVE_CRON: "*/15 * * * *",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ARCHIVE_CRON).toBe("*/15 * * * *");
      }
    });

    it("rejects invalid cron expressions with a descriptive error", () => {
      const invalidExpressions = ["invalid-cron", "not a cron", "60 * * * *", "abc"];
      for (const expr of invalidExpressions) {
        const parsed = envSchema.safeParse({
          ...baseValidEnv,
          ARCHIVE_CRON: expr,
        });
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          const issue = parsed.error.issues.find((i) => i.path.includes("ARCHIVE_CRON"));
          expect(issue).toBeDefined();
          expect(issue?.message).toBe("ARCHIVE_CRON must be a valid cron expression");
        }
      }
    });
  });
});
