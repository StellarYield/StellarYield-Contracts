import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: {
      PORT: "3000",
      NODE_ENV: "test",
      STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/stellaryield_test",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Measure application source only, excluding tests and code that is not
      // meaningfully unit-testable (process entrypoints, DB migrations/seed,
      // one-off scripts, and type-only modules).
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/db/migrate.ts",
        "src/db/seed.ts",
        "src/scripts/**",
        "src/types/**",
      ],
      // Regression-guard thresholds (#504). These are a ratchet set just below
      // current coverage so that `npm run test:coverage` fails if coverage
      // drops (e.g. a tested function is removed or new code lands untested).
      // Raise them as backend test coverage improves toward the 60% target.
      thresholds: {
        lines: 35,
        functions: 38,
        branches: 55,
      },
    },
  },
});
