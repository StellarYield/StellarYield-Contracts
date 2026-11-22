import { useVaultData } from "../hooks/useVaultData";
import {
  formatAmount,
  formatBps,
  formatDate,
  formatDuration,
  formatSharePrice,
  shortAddress,
} from "../lib/format";
import { ActionPanel } from "./ActionPanel";
import { OperatorPanel } from "./OperatorPanel";
import { Card, MicroLabel, Notice, Progress, Stat, StateBadge } from "./ui";

export function VaultDetail({
  vaultAddress,
  walletAddress,
  onBack,
}: {
  vaultAddress: string;
  walletAddress: string | null;
  onBack: () => void;
}) {
  const { vault, user, loading, error, refresh } = useVaultData(
    vaultAddress,
    walletAddress,
  );

  if (loading) {
    return (
      <div className="page section-tight stack" style={{ gap: 20 }}>
        <div className="skeleton" style={{ height: 120 }} />
        <div className="skeleton" style={{ height: 320 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page section-tight stack" style={{ gap: 20 }}>
        <button className="link-button" onClick={onBack} style={{ alignSelf: "flex-start" }}>
          ← All vaults
        </button>
        <Notice tone="danger">{error}</Notice>
      </div>
    );
  }

  if (!vault) {
    return (
      <div className="page section-tight stack" style={{ gap: 20 }}>
        <button className="link-button" onClick={onBack} style={{ alignSelf: "flex-start" }}>
          ← All vaults
        </button>
        <Card>
          <div className="stack" style={{ gap: 12 }}>
            <h1 style={{ fontSize: 30 }}>Vault not found</h1>
            <p className="muted" style={{ fontSize: 15 }}>
              We could not find a vault with that ID. It may have been mistyped or
              retired.
            </p>
            <button className="btn btn-soft" onClick={onBack} style={{ alignSelf: "flex-start" }}>
              Back to vaults
            </button>
          </div>
        </Card>
      </div>
    );
  }

  const fundingPercent = vault.fundingProgressBps / 100;

  return (
    <div className="page section-tight stack" style={{ gap: 24 }}>
      <button className="link-button" onClick={onBack} style={{ alignSelf: "flex-start" }}>
        ← All vaults
      </button>

      {/* ---- Header ------------------------------------------------------ */}
      <div className="row-between" style={{ flexWrap: "wrap", gap: 16 }}>
        <div className="stack" style={{ gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 38 }}>{vault.name}</h1>
            <StateBadge state={vault.state} />
            {vault.paused ? <span className="badge badge-danger">Paused</span> : null}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <span className="address-chip">{shortAddress(vault.address, 6, 6)}</span>
            <span className="muted" style={{ fontSize: 14 }}>
              {vault.rwaName}
              {vault.rwaCategory ? ` · ${vault.rwaCategory}` : ""}
            </span>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={() => void refresh()}>
          refresh
        </button>
      </div>

      {/* ---- Vault stats -------------------------------------------------- */}
      <Card>
        <div className="grid grid-4">
          <Stat
            label="Total assets"
            value={
              <span className="mono">
                {formatAmount(vault.totalAssets, vault.assetDecimals)}
              </span>
            }
            hint={vault.assetSymbol}
          />
          <Stat
            label="Share price"
            value={
              <span className="mono">
                {formatSharePrice(vault.sharePrice, vault.shareDecimals)}
              </span>
            }
            hint={`${vault.assetSymbol} per ${vault.symbol}`}
          />
          <Stat
            label="Expected APY"
            value={vault.expectedApy > 0 ? formatBps(vault.expectedApy) : "—"}
            accent
            hint="Set by the operator"
          />
          <Stat
            label="Yield distributed"
            value={
              <span className="mono">
                {formatAmount(vault.totalYieldDistributed, vault.assetDecimals)}
              </span>
            }
            hint={`Across ${vault.currentEpoch} epoch${vault.currentEpoch === 1 ? "" : "s"}`}
          />
        </div>

        <hr className="divider" style={{ margin: "24px 0" }} />

        <div className="grid grid-4">
          <Stat
            label="Shares outstanding"
            value={
              <span className="mono" style={{ fontSize: 18 }}>
                {formatAmount(vault.totalSupply, vault.shareDecimals)}
              </span>
            }
          />
          <Stat
            label="Maturity"
            value={<span style={{ fontSize: 18 }}>{formatDate(vault.maturityDate)}</span>}
            hint={
              vault.state === "Matured" ? "Matured" : formatDuration(vault.timeToMaturity)
            }
          />
          <Stat
            label="Exit fee"
            value={
              <span style={{ fontSize: 18 }}>{formatBps(vault.earlyRedemptionFeeBps)}</span>
            }
            hint="Early redemption"
          />
          <Stat
            label="Underlying"
            value={<span style={{ fontSize: 18 }}>{vault.assetSymbol}</span>}
            hint={shortAddress(vault.asset, 4, 4)}
          />
        </div>

        {vault.state === "Funding" && vault.fundingTarget > 0n ? (
          <>
            <hr className="divider" style={{ margin: "24px 0" }} />
            <div className="stack" style={{ gap: 10 }}>
              <div className="row-between">
                <MicroLabel>Funding progress</MicroLabel>
                <span className="mono" style={{ fontSize: 13 }}>
                  {formatAmount(vault.totalAssets, vault.assetDecimals)} /{" "}
                  {formatAmount(vault.fundingTarget, vault.assetDecimals)}{" "}
                  {vault.assetSymbol} ({fundingPercent.toFixed(1)}%)
                </span>
              </div>
              <Progress percent={fundingPercent} />
            </div>
          </>
        ) : null}
      </Card>

      {/* ---- Position + actions ------------------------------------------- */}
      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="stack" style={{ gap: 24 }}>
          <PositionCard vault={vault} user={user} walletAddress={walletAddress} />
          {user?.isOperator && walletAddress ? (
            <OperatorPanel
              vault={vault}
              user={user}
              walletAddress={walletAddress}
              onRefresh={refresh}
            />
          ) : null}
        </div>

        <ActionPanel
          vault={vault}
          user={user}
          walletAddress={walletAddress}
          onRefresh={refresh}
        />
      </div>

      {vault.rwaDocumentUri ? (
        <Card className="card-tight">
          <div className="row-between" style={{ flexWrap: "wrap" }}>
            <div className="stack" style={{ gap: 4 }}>
              <MicroLabel>Asset documentation</MicroLabel>
              <span className="muted" style={{ fontSize: 13, wordBreak: "break-all" }}>
                {vault.rwaDocumentUri}
              </span>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function PositionCard({
  vault,
  user,
  walletAddress,
}: {
  vault: ReturnType<typeof useVaultData>["vault"];
  user: ReturnType<typeof useVaultData>["user"];
  walletAddress: string | null;
}) {
  if (!vault) return null;

  if (!walletAddress || !user) {
    return (
      <Card>
        <div className="stack" style={{ gap: 12 }}>
          <div className="card-title">Your position</div>
          <p className="muted" style={{ fontSize: 14 }}>
            Connect a wallet to see your shares, accrued yield, and KYC status for this
            vault.
          </p>
        </div>
      </Card>
    );
  }

  const positionValue =
    vault.totalSupply > 0n
      ? (user.shareBalance * vault.totalAssets) / vault.totalSupply
      : 0n;

  return (
    <Card>
      <div className="stack" style={{ gap: 20 }}>
        <div className="row-between">
          <div className="card-title">Your position</div>
          <span className={`badge ${user.isKycVerified ? "badge-accent" : "badge-warn"}`}>
            {user.isKycVerified ? "KYC verified" : "KYC required"}
          </span>
        </div>

        <div className="grid grid-2" style={{ gap: 16 }}>
          <Stat
            label="Shares held"
            value={
              <span className="mono" style={{ fontSize: 22 }}>
                {formatAmount(user.shareBalance, vault.shareDecimals)}
              </span>
            }
            hint={vault.symbol}
          />
          <Stat
            label="Position value"
            value={
              <span className="mono" style={{ fontSize: 22 }}>
                {formatAmount(positionValue, vault.assetDecimals)}
              </span>
            }
            hint={vault.assetSymbol}
          />
          <Stat
            label="Claimable yield"
            value={
              <span className="mono" style={{ fontSize: 22 }}>
                {formatAmount(user.pendingYield, vault.assetDecimals)}
              </span>
            }
            accent
            hint={vault.assetSymbol}
          />
          <Stat
            label="Total deposited"
            value={
              <span className="mono" style={{ fontSize: 22 }}>
                {formatAmount(user.totalDeposited, vault.assetDecimals)}
              </span>
            }
            hint={vault.assetSymbol}
          />
        </div>

        <div className="card-sunken row-between">
          <MicroLabel>Wallet balance</MicroLabel>
          <span className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
            {user.assetTrustlineMissing ? (
              <span className="muted">No {vault.assetSymbol} trustline</span>
            ) : (
              `${formatAmount(user.assetBalance, vault.assetDecimals)} ${vault.assetSymbol}`
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}
