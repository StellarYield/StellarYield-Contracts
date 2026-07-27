// Shared raw-event fixture builders for indexer/unit/integration tests (#697).
//
// Each `make*Event` builder returns a minimal, valid raw on-chain event object
// that `Indexer.processEvent` (src/services/indexer.ts) and its standalone
// `parse*Event` functions accept, matching the `{ topic, value, ... }` shape
// used throughout the existing test suite (see src/services/indexer.test.ts
// and src/deposit-indexing.e2e.test.ts).
import { xdr, nativeToScVal } from "@stellar/stellar-sdk";

export const VAULT_CONTRACT = "CDLZFC3SYJYHZDQA6M57EYUC2XBDA6LQF3M6KFRDZ7TXJYJL2K3BMNOP";
export const USER_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2A";
export const OTHER_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA";

interface BaseOverrides {
  contractId?: string;
  ledger?: number;
  id?: string;
  txHash?: string;
  ledgerClosedAt?: string;
}

let eventCounter = 0;

function baseEvent(overrides: BaseOverrides = {}) {
  eventCounter += 1;
  return {
    type: "contract" as const,
    contractId: overrides.contractId ?? VAULT_CONTRACT,
    ledger: overrides.ledger ?? 1000,
    id: overrides.id ?? `fixture-evt-${eventCounter}`,
    txHash: overrides.txHash ?? `fixture-tx-${eventCounter}`,
    ledgerClosedAt: overrides.ledgerClosedAt ?? "2025-01-01T00:00:00.000Z",
    pagingToken: "",
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
  };
}

export function makeDepositEvent(
  overrides: Partial<BaseOverrides & {
    caller: string;
    receiver: string;
    assets: bigint;
    shares: bigint;
  }> = {},
) {
  const caller = overrides.caller ?? USER_ADDRESS;
  const receiver = overrides.receiver ?? USER_ADDRESS;
  const assets = overrides.assets ?? 1_000n;
  const shares = overrides.shares ?? 1_000n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("deposit"), nativeToScVal(caller), nativeToScVal(receiver)],
    value: nativeToScVal([assets, shares]),
  };
}

export function makeWithdrawEvent(
  overrides: Partial<BaseOverrides & {
    caller: string;
    receiver: string;
    owner: string;
    assets: bigint;
    shares: bigint;
  }> = {},
) {
  const caller = overrides.caller ?? USER_ADDRESS;
  const receiver = overrides.receiver ?? USER_ADDRESS;
  const owner = overrides.owner ?? USER_ADDRESS;
  const assets = overrides.assets ?? 500n;
  const shares = overrides.shares ?? 500n;
  return {
    ...baseEvent(overrides),
    topic: [
      nativeToScVal("withdraw"),
      nativeToScVal(caller),
      nativeToScVal(receiver),
      nativeToScVal(owner),
    ],
    value: nativeToScVal([assets, shares]),
  };
}

export function makeYieldDistributedEvent(
  overrides: Partial<BaseOverrides & {
    epoch: number;
    amount: bigint;
    timestamp: bigint;
  }> = {},
) {
  const epoch = overrides.epoch ?? 1;
  const amount = overrides.amount ?? 10_000n;
  const timestamp = overrides.timestamp ?? 1_700_000_000n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("yield_dis"), nativeToScVal(epoch)],
    value: nativeToScVal([amount, timestamp]),
  };
}

export function makeVaultStateChangedEvent(
  overrides: Partial<BaseOverrides & {
    oldState: string;
    newState: string;
  }> = {},
) {
  const oldState = overrides.oldState ?? "Funding";
  const newState = overrides.newState ?? "Active";
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("st_chg")],
    value: nativeToScVal({ oldState, newState }),
  };
}

export function makeVaultCreatedEvent(
  overrides: Partial<BaseOverrides & {
    asset: string;
    name: string;
    symbol: string;
    rwaCategory: string;
    fundingTarget: bigint;
    fundingDeadline: number;
    minDeposit: bigint;
    maxDepositPerUser: bigint;
  }> = {},
) {
  const asset = overrides.asset ?? "XLM";
  const name = overrides.name ?? "Stellar Lumens Vault";
  const symbol = overrides.symbol ?? "SVXLM";
  const rwaCategory = overrides.rwaCategory ?? "RealEstate";
  const fundingTarget = overrides.fundingTarget ?? 1_000_000n;
  const fundingDeadline = overrides.fundingDeadline ?? 1_800_000_000;
  const minDeposit = overrides.minDeposit ?? 100n;
  const maxDepositPerUser = overrides.maxDepositPerUser ?? 100_000n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("v_create"), nativeToScVal(overrides.contractId ?? VAULT_CONTRACT)],
    value: nativeToScVal({
      asset,
      name,
      symbol,
      rwa_category: rwaCategory,
      funding_target: fundingTarget,
      funding_deadline: fundingDeadline,
      min_deposit: minDeposit,
      max_deposit_per_user: maxDepositPerUser,
    }),
  };
}

export function makeCancelFundingEvent(overrides: Partial<BaseOverrides> = {}) {
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("fund_cxl")],
    value: xdr.ScVal.scvVoid(),
  };
}

export function makeVaultRemovedEvent(overrides: Partial<BaseOverrides> = {}) {
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("vault_removed")],
  };
}

export function makeOperatorAddedEvent(
  overrides: Partial<BaseOverrides & {
    caller: string;
    operator: string;
    timestamp: bigint;
  }> = {},
) {
  const caller = overrides.caller ?? USER_ADDRESS;
  const operator = overrides.operator ?? OTHER_ADDRESS;
  const timestamp = overrides.timestamp ?? 1_700_000_000n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("op_add"), nativeToScVal(caller), nativeToScVal(operator)],
    value: nativeToScVal(timestamp),
  };
}

export function makeOperatorRemovedEvent(
  overrides: Partial<BaseOverrides & {
    caller: string;
    operator: string;
    timestamp: bigint;
    reason: string | null;
  }> = {},
) {
  const caller = overrides.caller ?? USER_ADDRESS;
  const operator = overrides.operator ?? OTHER_ADDRESS;
  const timestamp = overrides.timestamp ?? 1_700_000_000n;
  const reason = overrides.reason === undefined ? "manual removal" : overrides.reason;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("op_rem"), nativeToScVal(caller), nativeToScVal(operator)],
    value: nativeToScVal([timestamp, reason]),
  };
}

export function makeRoleGrantedEvent(
  overrides: Partial<BaseOverrides & {
    userAddress: string;
    role: string;
  }> = {},
) {
  const userAddress = overrides.userAddress ?? USER_ADDRESS;
  const role = overrides.role ?? "Operator";
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("role_grt"), nativeToScVal(userAddress)],
    value: nativeToScVal(role),
  };
}

export function makeRoleRevokedEvent(
  overrides: Partial<BaseOverrides & {
    userAddress: string;
    role: string;
  }> = {},
) {
  const userAddress = overrides.userAddress ?? USER_ADDRESS;
  const role = overrides.role ?? "Operator";
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("role_rvk"), nativeToScVal(userAddress)],
    value: nativeToScVal(role),
  };
}

export function makeRequestEarlyRedemptionEvent(
  overrides: Partial<BaseOverrides & {
    userAddress: string;
    requestId: number;
    shares: bigint;
    timestamp: bigint;
  }> = {},
) {
  const userAddress = overrides.userAddress ?? USER_ADDRESS;
  const requestId = overrides.requestId ?? 1;
  const shares = overrides.shares ?? 250n;
  const timestamp = overrides.timestamp ?? 1_700_000_000n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("erq_req"), nativeToScVal(userAddress)],
    value: nativeToScVal([requestId, shares, timestamp]),
  };
}

export function makeYieldClaimedEvent(
  overrides: Partial<BaseOverrides & {
    user: string;
    amount: bigint;
    epoch: number;
  }> = {},
) {
  const user = overrides.user ?? USER_ADDRESS;
  const amount = overrides.amount ?? 1_000n;
  const epoch = overrides.epoch ?? 1;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("yield_clm"), nativeToScVal(user)],
    value: nativeToScVal([amount, epoch]),
  };
}

export function makeYieldClaimedPartialEvent(
  overrides: Partial<BaseOverrides & {
    user: string;
    claimed: bigint;
    shortfall: bigint;
    epoch: number;
  }> = {},
) {
  const user = overrides.user ?? USER_ADDRESS;
  const claimed = overrides.claimed ?? 700n;
  const shortfall = overrides.shortfall ?? 300n;
  const epoch = overrides.epoch ?? 1;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("prt_yld"), nativeToScVal(user)],
    value: nativeToScVal([claimed, shortfall, epoch]),
  };
}

export function makeEarlyRedemptionProcessedEvent(
  overrides: Partial<BaseOverrides & {
    user: string;
    requestId: number;
    netAssets: bigint;
  }> = {},
) {
  const user = overrides.user ?? USER_ADDRESS;
  const requestId = overrides.requestId ?? 1;
  const netAssets = overrides.netAssets ?? 480n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("erq_done"), nativeToScVal(user)],
    value: nativeToScVal([requestId, netAssets]),
  };
}

export function makeEarlyRedemptionCancelledEvent(
  overrides: Partial<BaseOverrides & {
    user: string;
    requestId: number;
    shares: bigint;
  }> = {},
) {
  const user = overrides.user ?? USER_ADDRESS;
  const requestId = overrides.requestId ?? 1;
  const shares = overrides.shares ?? 250n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("erq_can"), nativeToScVal(user)],
    value: nativeToScVal([requestId, shares]),
  };
}

export function makeZkmeVerifierUpdatedEvent(
  overrides: Partial<BaseOverrides & {
    caller: string;
    oldVerifier: string;
    newVerifier: string;
  }> = {},
) {
  const caller = overrides.caller ?? USER_ADDRESS;
  const oldVerifier = overrides.oldVerifier ?? OTHER_ADDRESS;
  const newVerifier = overrides.newVerifier ?? USER_ADDRESS;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("zkme_upd"), nativeToScVal(caller)],
    value: nativeToScVal([oldVerifier, newVerifier]),
  };
}

export function makeAdminTransferredEvent(
  overrides: Partial<BaseOverrides & {
    oldAdmin: string;
    newAdmin: string;
  }> = {},
) {
  const oldAdmin = overrides.oldAdmin ?? USER_ADDRESS;
  const newAdmin = overrides.newAdmin ?? OTHER_ADDRESS;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("adm_xfr")],
    value: nativeToScVal([oldAdmin, newAdmin]),
  };
}

export function makeDefaultsUpdatedEvent(
  overrides: Partial<BaseOverrides & {
    asset: string;
    zkmeVerifier: string;
    cooperator: string;
  }> = {},
) {
  const asset = overrides.asset ?? "XLM";
  const zkmeVerifier = overrides.zkmeVerifier ?? USER_ADDRESS;
  const cooperator = overrides.cooperator ?? OTHER_ADDRESS;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("def_upd")],
    value: nativeToScVal([asset, zkmeVerifier, cooperator]),
  };
}

export function makeKycSetEvent(
  overrides: Partial<BaseOverrides & {
    user: string;
    verified: boolean;
    timestamp: bigint;
  }> = {},
) {
  const user = overrides.user ?? USER_ADDRESS;
  const verified = overrides.verified ?? true;
  const timestamp = overrides.timestamp ?? 1_700_000_000n;
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("kyc_set"), nativeToScVal(user)],
    value: nativeToScVal([verified, timestamp]),
  };
}

export function makePausedEvent(overrides: Partial<BaseOverrides> = {}) {
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("paused")],
    value: xdr.ScVal.scvVoid(),
  };
}

export function makeUnpausedEvent(overrides: Partial<BaseOverrides> = {}) {
  return {
    ...baseEvent(overrides),
    topic: [nativeToScVal("unpaused")],
    value: xdr.ScVal.scvVoid(),
  };
}
