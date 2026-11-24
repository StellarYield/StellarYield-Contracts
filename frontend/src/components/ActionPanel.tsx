import { useMemo, useState } from "react";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import type { VaultData, UserData } from "../hooks/useVaultData";
import { useTransaction } from "../hooks/useTransaction";
import { formatAmount, formatBps, parseAmount, shortAddress } from "../lib/format";
import { AmountInput, Card, MicroLabel, Notice, Spinner } from "./ui";
import { TxStatus } from "./TxStatus";

const addr = (a: string) => Address.fromString(a).toScVal();
const i128 = (v: bigint) => nativeToScVal(v, { type: "i128" });

type Tab = "deposit" | "claim" | "redeem";

/**
 * The investor-side contract interactions. Which tabs are offered — and whether
 * they can be submitted — follows the vault's lifecycle state, so the UI never
 * invites a call the contract would reject.
 */
export function ActionPanel({
  vault,
  user,
  walletAddress,
  onRefresh,
}: {
  vault: VaultData;
  user: UserData | null;
  walletAddress: string | null;
  onRefresh: () => Promise<void>;
}) {
  const tx = useTransaction(onRefresh);
  const [tab, setTab] = useState<Tab>("deposit");

  const availableTabs = useMemo<Tab[]>(() => {
    switch (vault.state) {
      case "Funding":
        return ["deposit"];
      case "Active":
        return ["deposit", "claim", "redeem"];
      case "Matured":
        return ["claim", "redeem"];
      case "Cancelled":
        return ["redeem"];
      default:
        return [];
    }
  }, [vault.state]);

  const activeTab = availableTabs.includes(tab) ? tab : availableTabs[0];

  if (!walletAddress) {
    return (
      <Card>
        <div className="stack" style={{ gap: 16 }}>
          <div className="card-title">Actions</div>
          <Notice tone="info">
            Connect Freighter to deposit, claim yield, and redeem.
          </Notice>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="stack" style={{ gap: 20 }}>
        <div className="card-title">Actions</div>

        <BlockingNotices vault={vault} user={user} />

        {availableTabs.length === 0 ? (
          <Notice>
            This vault is {vault.state.toLowerCase()} — no investor actions remain.
          </Notice>
        ) : (
          <>
            {availableTabs.length > 1 ? (
              <div className="tabs" role="tablist">
                {availableTabs.map((t) => (
                  <button
                    key={t}
                    role="tab"
                    className="tab"
                    aria-selected={activeTab === t}
                    onClick={() => setTab(t)}
                  >
                    {TAB_LABELS[t]}
                  </button>
                ))}
              </div>
            ) : null}

            {activeTab === "deposit" ? (
              <DepositForm
                vault={vault}
                user={user}
                walletAddress={walletAddress}
                tx={tx}
              />
            ) : null}
            {activeTab === "claim" ? (
              <ClaimForm vault={vault} user={user} walletAddress={walletAddress} tx={tx} />
            ) : null}
            {activeTab === "redeem" ? (
              <RedeemForm
                vault={vault}
                user={user}
                walletAddress={walletAddress}
                tx={tx}
              />
            ) : null}
          </>
        )}

        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </div>
    </Card>
  );
}

const TAB_LABELS: Record<Tab, string> = {
  deposit: "Deposit",
  claim: "Claim yield",
  redeem: "Redeem",
};

type TxHandle = ReturnType<typeof useTransaction>;

/** Conditions that will make every write revert — surface them up front. */
function BlockingNotices({ vault, user }: { vault: VaultData; user: UserData | null }) {
  return (
    <>
      {vault.paused ? (
        <Notice tone="warn">
          The vault is paused by its operator. Deposits and redemptions are blocked.
        </Notice>
      ) : null}
      {user?.isBlacklisted ? (
        <Notice tone="danger">This address is blacklisted on the vault.</Notice>
      ) : null}
      {user?.assetTrustlineMissing ? (
        <Notice tone="warn">
          This account holds no {vault.assetSymbol} trustline, so it cannot receive or
          deposit the asset. Add {vault.assetSymbol} (issuer{" "}
          <span className="code">{shortAddress(vault.asset, 4, 4)}</span>) in Freighter,
          then refresh.
        </Notice>
      ) : null}
      {user && !user.isKycVerified ? (
        <Notice tone="warn">
          This address has not passed KYC with the vault's zkMe verifier, so deposits
          will be rejected.
        </Notice>
      ) : null}
    </>
  );
}

function DepositForm({
  vault,
  user,
  walletAddress,
  tx,
}: {
  vault: VaultData;
  user: UserData | null;
  walletAddress: string;
  tx: TxHandle;
}) {
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const remainingToTarget =
    vault.state === "Funding" && vault.fundingTarget > 0n
      ? vault.fundingTarget - vault.totalAssets
      : null;

  const submit = async () => {
    setInputError(null);
    let assets: bigint;
    try {
      assets = parseAmount(value, vault.assetDecimals);
    } catch (err) {
      setInputError((err as Error).message);
      return;
    }

    if (user && assets > user.assetBalance) {
      setInputError(`Balance is only ${formatAmount(user.assetBalance, vault.assetDecimals)} ${vault.assetSymbol}`);
      return;
    }
    if (vault.minDeposit > 0n && assets < vault.minDeposit) {
      setInputError(
        `Minimum deposit is ${formatAmount(vault.minDeposit, vault.assetDecimals)} ${vault.assetSymbol}`,
      );
      return;
    }
    if (remainingToTarget !== null && assets > remainingToTarget) {
      setInputError(
        `Only ${formatAmount(remainingToTarget, vault.assetDecimals)} ${vault.assetSymbol} left before the funding target`,
      );
      return;
    }

    const ok = await tx.run({
      action: "Deposit",
      contractId: vault.address,
      method: "deposit",
      args: [addr(walletAddress), i128(assets), addr(walletAddress)],
      walletAddress,
    });
    if (ok) setValue("");
  };

  const maxDeposit = (() => {
    if (!user) return null;
    const candidates = [user.assetBalance, user.maxDeposit];
    if (remainingToTarget !== null && remainingToTarget > 0n) {
      candidates.push(remainingToTarget);
    }
    return candidates.reduce((a, b) => (b < a ? b : a));
  })();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="field">
        <div className="row-between">
          <label className="micro-label" htmlFor="deposit-amount">
            You deposit
          </label>
          <span className="faint" style={{ fontSize: 12 }}>
            Balance: {formatAmount(user?.assetBalance, vault.assetDecimals)}{" "}
            {vault.assetSymbol}
          </span>
        </div>
        <AmountInput
          id="deposit-amount"
          value={value}
          onChange={setValue}
          suffix={vault.assetSymbol}
          disabled={tx.busy}
          maxLabel={`Use maximum ${vault.assetSymbol} deposit for ${vault.name}`}
          onMax={
            maxDeposit && maxDeposit > 0n
              ? () => setValue(formatAmount(maxDeposit, vault.assetDecimals, { maxFractionDigits: vault.assetDecimals }).replace(/,/g, ""))
              : undefined
          }
        />
      </div>

      <div className="card-sunken stack" style={{ gap: 6 }}>
        <MicroLabel>You receive</MicroLabel>
        <strong className="accent" style={{ fontSize: 16 }}>
          {value && !inputError ? `≈ ${value} ` : ""}
          {vault.symbol} shares
        </strong>
        <span className="faint" style={{ fontSize: 12 }}>
          Minted at the current share price. Yield accrues to shares you hold when the
          operator distributes an epoch.
        </span>
      </div>

      {vault.minDeposit > 0n ? (
        <span className="faint" style={{ fontSize: 12 }}>
          Minimum deposit {formatAmount(vault.minDeposit, vault.assetDecimals)}{" "}
          {vault.assetSymbol}
          {vault.maxDepositPerUser > 0n
            ? ` · per-user cap ${formatAmount(vault.maxDepositPerUser, vault.assetDecimals)} ${vault.assetSymbol}`
            : ""}
        </span>
      ) : null}

      {inputError ? <Notice tone="danger" role="alert">{inputError}</Notice> : null}

      <button
        className="btn btn-primary btn-block"
        onClick={submit}
        disabled={tx.busy || vault.paused || !value}
        aria-label={`Deposit ${vault.assetSymbol} into ${vault.name}`}
      >
        {tx.busy ? <Spinner /> : null}
        {tx.busy ? "processing…" : "deposit"}
      </button>
    </div>
  );
}

function ClaimForm({
  vault,
  user,
  walletAddress,
  tx,
}: {
  vault: VaultData;
  user: UserData | null;
  walletAddress: string;
  tx: TxHandle;
}) {
  const pending = user?.pendingYield ?? 0n;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card-sunken stack" style={{ gap: 6 }}>
        <MicroLabel>Claimable yield</MicroLabel>
        <strong className="accent mono" style={{ fontSize: 26 }}>
          {formatAmount(pending, vault.assetDecimals)} {vault.assetSymbol}
        </strong>
        <span className="faint" style={{ fontSize: 12 }}>
          Accrued across {vault.currentEpoch} distributed epoch
          {vault.currentEpoch === 1 ? "" : "s"}, pro-rata to your share balance at each
          distribution.
        </span>
      </div>

      <button
        className="btn btn-primary btn-block"
        onClick={() =>
          tx.run({
            action: "Claim yield",
            contractId: vault.address,
            method: "claim_yield",
            args: [addr(walletAddress)],
            walletAddress,
          })
        }
        disabled={tx.busy || pending <= 0n || vault.paused}
        aria-label={`Claim yield from ${vault.name}`}
      >
        {tx.busy ? <Spinner /> : null}
        {tx.busy ? "processing…" : pending > 0n ? "claim yield" : "nothing to claim"}
      </button>
    </div>
  );
}

function RedeemForm({
  vault,
  user,
  walletAddress,
  tx,
}: {
  vault: VaultData;
  user: UserData | null;
  walletAddress: string;
  tx: TxHandle;
}) {
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const shares = user?.shareBalance ?? 0n;

  // Cancelled vaults refund the full balance in one call — no amount to choose.
  if (vault.state === "Cancelled") {
    return (
      <div className="stack" style={{ gap: 16 }}>
        <Notice tone="warn">
          This funding round was cancelled. Refund returns your full deposit and burns
          your shares.
        </Notice>
        <div className="card-sunken stack" style={{ gap: 6 }}>
          <MicroLabel>Refundable</MicroLabel>
          <strong className="mono" style={{ fontSize: 20 }}>
            {formatAmount(shares, vault.shareDecimals)} {vault.symbol}
          </strong>
        </div>
        <button
          className="btn btn-primary btn-block"
          onClick={() =>
            tx.run({
              action: "Refund",
              contractId: vault.address,
              method: "refund",
              args: [addr(walletAddress)],
              walletAddress,
            })
          }
          disabled={tx.busy || shares <= 0n}
          aria-label={`Claim refund from ${vault.name}`}
        >
          {tx.busy ? <Spinner /> : null}
          {tx.busy ? "processing…" : "claim refund"}
        </button>
      </div>
    );
  }

  const isMatured = vault.state === "Matured";

  const submit = async () => {
    setInputError(null);
    let amount: bigint;
    try {
      amount = parseAmount(value, vault.shareDecimals);
    } catch (err) {
      setInputError((err as Error).message);
      return;
    }
    if (amount > shares) {
      setInputError(`You hold only ${formatAmount(shares, vault.shareDecimals)} ${vault.symbol}`);
      return;
    }

    const ok = isMatured
      ? await tx.run({
          action: "Redeem",
          contractId: vault.address,
          method: "redeem_at_maturity",
          args: [addr(walletAddress), i128(amount), addr(walletAddress), addr(walletAddress)],
          walletAddress,
        })
      : await tx.run({
          action: "Early redemption request",
          contractId: vault.address,
          method: "request_early_redemption",
          args: [addr(walletAddress), i128(amount)],
          walletAddress,
        });
    if (ok) setValue("");
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {isMatured ? (
        <Notice tone="accent">
          The vault has matured. Redeeming burns shares and returns principal plus any
          unclaimed yield immediately.
        </Notice>
      ) : (
        <Notice tone="warn">
          The vault is still active. Redeeming early escrows your shares into a request
          the operator must process, and charges a{" "}
          {formatBps(vault.earlyRedemptionFeeBps)} exit fee.
        </Notice>
      )}

      <div className="field">
        <div className="row-between">
          <label className="micro-label" htmlFor="redeem-amount">
            You redeem
          </label>
          <span className="faint" style={{ fontSize: 12 }}>
            Holding: {formatAmount(shares, vault.shareDecimals)} {vault.symbol}
          </span>
        </div>
        <AmountInput
          id="redeem-amount"
          value={value}
          onChange={setValue}
          suffix={vault.symbol}
          disabled={tx.busy}
          maxLabel={`Use maximum ${vault.symbol} redemption for ${vault.name}`}
          onMax={
            shares > 0n
              ? () =>
                  setValue(
                    formatAmount(shares, vault.shareDecimals, {
                      maxFractionDigits: vault.shareDecimals,
                    }).replace(/,/g, ""),
                  )
              : undefined
          }
        />
      </div>

      {inputError ? <Notice tone="danger" role="alert">{inputError}</Notice> : null}

      <button
        className="btn btn-primary btn-block"
        onClick={submit}
        disabled={tx.busy || shares <= 0n || vault.paused || !value}
        aria-label={isMatured
          ? `Redeem ${vault.symbol} shares from ${vault.name}`
          : `Request early redemption of ${vault.symbol} shares from ${vault.name}`}
      >
        {tx.busy ? <Spinner /> : null}
        {tx.busy
          ? "processing…"
          : isMatured
            ? "redeem shares"
            : "request early redemption"}
      </button>
    </div>
  );
}
