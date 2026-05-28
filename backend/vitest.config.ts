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
  },
});
