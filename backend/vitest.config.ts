import { defineConfig } from "vitest/config";

export default defineConfig({
  // Apollo Server and our own graphql/schema.ts both import "graphql". Without
  // this, Vite's SSR module graph can end up loading "graphql" once as an
  // externalized dependency and once inlined via @apollo/server, producing two
  // separate GraphQLSchema classes and tripping graphql-js's cross-realm
  // `instanceof` checks (#765).
  resolve: {
    dedupe: ["graphql"],
  },
  test: {
    server: {
      deps: {
        inline: ["@apollo/server", "graphql"],
      },
    },
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
