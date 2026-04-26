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

## Example 2 — Claim all pending yield

The `claim_yield` function claims all unclaimed yield across all epochs in a single transaction.

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  SingleRwaVaultClient,
  buildUnsignedTransaction,
} from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const user = "G...";
const vaultId = "C...";

const account = await server.getAccount(user);
const vault = new SingleRwaVaultClient(vaultId);

// Check pending yield before claiming
const pending = await vault.pendingYield(user);
console.log(`Pending yield: ${pending}`);

// Claim all pending yield
const op = vault.claimYield(user);

const tx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: op,
});

const sim = await server.simulateTransaction(tx);
// ... sign & send
```

**When to use:**

- User wants to claim all available yield at once
- Simplest integration for wallets and frontends
- Most gas-efficient for users who claim periodically

---

## Example 3 — Claim yield for a specific epoch

The `claim_yield_for_epoch` function allows granular claiming of yield from individual epochs. This is useful when yield has a vesting period or for advanced integrations.

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  SingleRwaVaultClient,
  buildUnsignedTransaction,
} from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const user = "G...";
const vaultId = "C...";

const account = await server.getAccount(user);
const vault = new SingleRwaVaultClient(vaultId);

// Check yield for specific epoch
const epochNumber = 3;
const pendingForEpoch = await vault.pendingYieldForEpoch(user, epochNumber);
console.log(`Pending yield for epoch ${epochNumber}: ${pendingForEpoch}`);

// Claim only epoch 3 yield
const op = vault.claimYieldForEpoch(user, epochNumber);

const tx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: op,
});

const sim = await server.simulateTransaction(tx);
// ... sign & send
```

**When to use:**

- Yield has a vesting period and user wants to claim vested portions incrementally
- User wants to defer tax events by claiming specific epochs
- Advanced integrations that need epoch-level control

**Vesting example:**

```typescript
// Day 1: Epoch 1 distributed with 10,000 yield
// (operator calls distribute_yield)

// Day 15: 50% vested, user claims half
const claimed1 = await vault.claimYieldForEpoch(user, 1);
// claimed1 = 5,000 (50% of user's share)

// Day 31: Fully vested, user claims remainder
const claimed2 = await vault.claimYieldForEpoch(user, 1);
// claimed2 = 5,000 (remaining 50%)
```

---

## Example 4 — Create a vault via the factory

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  VaultFactoryClient,
  buildUnsignedTransaction,
} from "@stellaryield/sdk";

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

## Example 5 — Redeem shares at maturity

Once the vault reaches the `Matured` state the operator calls `mature_vault`, after which investors can redeem their full principal plus any unclaimed yield in a single transaction.

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  SingleRwaVaultClient,
  buildUnsignedTransaction,
} from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const user = "G...";
const vaultId = "C...";

const account = await server.getAccount(user);
const vault = new SingleRwaVaultClient(vaultId);

// Check current share balance
const sharesOp = vault.balance(user);
// simulate to read balance, then redeem the full amount
const shares = 5_000_000n; // stroops of share tokens

const op = vault.redeemAtMaturity(user, shares, user, user);
const tx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: op,
});

const sim = await server.simulateTransaction(tx);
if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
// assemble with sorobanData from sim, sign, submit
```

**Early redemption (while vault is Active):**

```typescript
// Request an early exit — shares are escrowed until the operator processes it
const requestOp = vault.requestEarlyRedemption(user, shares);
const requestTx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: requestOp,
});
const requestSim = await server.simulateTransaction(requestTx);
// ... sign & submit; the response includes the queue position hint in events
```

---

## Example 6 — List vaults from the factory

Use the `VaultFactoryClient` to discover all deployed vaults or filter by asset.

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  VaultFactoryClient,
  simulateInvocation,
} from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const factoryId = "C..."; // VaultFactory contract address
const factory = new VaultFactoryClient(factoryId);

const account = await server.getAccount("G...");

// All registered vaults (returns Vec<Address>)
const allVaults = await simulateInvocation<string[]>({
  server,
  account,
  networkPassphrase: Networks.TESTNET,
  contractId: factory.contractId,
  method: "get_single_rwa_vaults",
  args: [],
});
console.log("Vault addresses:", allVaults);

// Paginated list — useful for large registries
const page = factory.getVaultsPaginated(/* offset */ 0, /* limit */ 10);
const pageTx = buildUnsignedTransaction({
  account,
  networkPassphrase: Networks.TESTNET,
  operation: page,
});
const pageSim = await server.simulateTransaction(pageTx);
// parse pageSim.result?.retval for the Vec<Address> value

// Vaults backed by a specific asset (e.g. USDC)
const usdcVaultsOp = factory.getVaultsByAsset("C...USDC...");
```

---

## Example 7 — Status and config checks

Read vault state, configuration, and a user's position without any on-chain writes.

```typescript
import { Networks, rpc } from "@stellar/stellar-sdk";
import {
  SingleRwaVaultClient,
  simulateInvocation,
} from "@stellaryield/sdk";

const server = new rpc.Server("https://soroban-testnet.stellar.org");
const user = "G...";
const vaultId = "C...";
const vault = new SingleRwaVaultClient(vaultId);
const account = await server.getAccount(user);

// One-call vault overview (state, total assets, epoch, maturity date …)
const overview = await simulateInvocation({
  server,
  account,
  networkPassphrase: Networks.TESTNET,
  contractId: vault.contractId,
  method: "get_vault_overview",
  args: [],
});
console.log("Vault overview:", overview);

// Consolidated config snapshot — cache and refresh only on relevant events
// (dep_lim, fee_set, zkme_upd, coop_upd)
const config = await simulateInvocation({
  server,
  account,
  networkPassphrase: Networks.TESTNET,
  contractId: vault.contractId,
  method: "get_config_snapshot",
  args: [],
});
console.log("Fee bps:", config.early_redemption_fee_bps);
console.log("Min deposit:", config.min_deposit);

// Per-user summary (balance, pending yield, KYC status …)
const userOp = vault.invoke("get_user_overview", /* scAddress(user) */ );
// or use simulateInvocation with method "get_user_overview"

// KYC check before attempting a deposit
const kyc = await simulateInvocation<boolean>({
  server,
  account,
  networkPassphrase: Networks.TESTNET,
  contractId: vault.contractId,
  method: "is_kyc_verified",
  args: [/* scAddress(user) */],
});
if (!kyc) {
  console.warn("User has not passed KYC — deposit will be rejected.");
}
```

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
  args: [
    /* use scI128 from encode helpers */
  ],
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
