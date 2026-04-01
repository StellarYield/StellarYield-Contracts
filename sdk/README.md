# @stellaryield/sdk

TypeScript helpers for interacting with **StellarYield** Soroban contracts: the **Single RWA Vault** and **Vault Factory**. It wraps `@stellar/stellar-sdk` with typed parameters, transaction builders, simulation helpers, Freighter signing, and event parsing.

## Install

```bash
npm install @stellaryield/sdk @stellar/stellar-sdk
```

Peer usage assumes a Soroban RPC endpoint (e.g. Stellar testnet/mainnet Soroban RPC).

## Core concepts

1. **Clients** (`SingleRwaVaultClient`, `VaultFactoryClient`) produce **invoke host function operations** for a given contract id (`C…` address).
2. Wrap an operation in **`buildUnsignedTransaction`** (with a loaded `Account` from RPC) to get an unsigned `Transaction`.
3. Call **`simulateTransaction`** (from `@stellar/stellar-sdk/rpc` or the re-export in `./builders`) to preflight; use **`simulateInvocation`** for read-only view calls that return a decoded value.
4. Sign with your wallet; in the browser you can use **`signTransactionWithFreighter`**.

---

## Example 1 — Deposit into a vault

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  SingleRwaVaultClient,
  buildUnsignedTransaction,
} from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const user = "G..."; // public key
const vaultId = "C..."; // SingleRWAVault contract

const account = await server.getAccount(user);
const vault = new SingleRwaVaultClient(vaultId);

const op = vault.deposit(user, 10_000_000n, user); // amounts in stroops
const tx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: op,
});

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);

// then: assemble with sorobanData from sim, sign, submit (see Stellar docs)
```

---

## Example 2 — Claim yield

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import { SingleRwaVaultClient, buildUnsignedTransaction } from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const user = "G...";
const vaultId = "C...";

const account = await server.getAccount(user);
const vault = new SingleRwaVaultClient(vaultId);
const op = vault.claimYield(user);

const tx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: op,
});

const sim = await server.simulateTransaction(tx);
// ... sign & send
```

---

## Example 3 — Create a vault via the factory

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import { VaultFactoryClient, buildUnsignedTransaction } from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const operator = "G...";
const factoryId = "C..."; // VaultFactory

const account = await server.getAccount(operator);
const factory = new VaultFactoryClient(factoryId);

const op = factory.createSingleRwaVaultFull({
  caller: operator,
  params: {
    asset: "C...USDC...",
    name: "US Treasury Bill Vault",
    symbol: "syUSTB",
    rwa_name: "US T-Bill",
    rwa_symbol: "USTB",
    rwa_document_uri: "ipfs://...",
    rwa_category: "Treasury",
    expected_apy: 500,
    maturity_date: 2_000_000_000n,
    funding_deadline: 0n,
    funding_target: 1_000_000_000n,
    min_deposit: 1_000n,
    max_deposit_per_user: 0n,
    early_redemption_fee_bps: 200,
  },
});

const tx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: op,
});
```

> **Note:** Soroban `String` arguments are standard JavaScript strings; the SDK passes them through `nativeToScVal`. Replace placeholder strings with your product metadata.

---

## Read-only simulation (preview / views)

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import { SingleRwaVaultClient, simulateInvocation } from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const account = await server.getAccount("G...");
const vault = new SingleRwaVaultClient("C...");

const shares = await simulateInvocation<bigint>({
  server,
  account,
  networkPassphrase: Networks.TESTNET,
  contractId: vault.contractId,
  method: "preview_deposit",
  args: [/* use scI128 from encode helpers */],
});
```

Prefer using `vault.previewDeposit(assets)` and passing the resulting operation into a single-op transaction for `simulateTransaction`, or extend the SDK with thin wrappers as needed.

---

## Events

```typescript
import { parseVaultEvents } from "@stellaryield/sdk";
// After fetching transaction meta with contract events:
const parsed = parseVaultEvents(diagnosticEvents);
```

---

## Utilities

- `formatShares(amount, decimals)` — human-readable share amounts.
- `calculateYieldApy(yieldAmount, principal, durationSeconds)` — simple APY estimate.
- `isVaultActive(state)` / `isVaultRedeemable(state)` — helpers for `VaultState`.

---

## Generating bindings from WASM

You can augment this package with Stellar CLI–generated TypeScript bindings for exact ABI alignment:

```bash
stellar contract bindings typescript --network testnet --contract-id C... --output-dir ./generated
```

Use generated types for strict on-chain parity; keep `@stellaryield/sdk` for ergonomic builders and docs.

---

## License

MIT (match the repository license if different).
