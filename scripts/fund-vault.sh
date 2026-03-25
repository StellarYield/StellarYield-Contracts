#!/usr/bin/env bash
# =============================================================================
# fund-vault.sh — Deposit test tokens into a StellarYield vault
#
# Usage:
#   ./scripts/fund-vault.sh [--non-interactive]
#
# Environment variables (all prompted if not set):
#   VAULT_ADDRESS    — contract ID of the target vault
#   ASSET            — contract ID of the deposit asset (e.g. USDC)
#   DEPOSITOR        — Stellar address making the deposit (must be KYC'd)
#   SOURCE_ACCOUNT   — stellar-cli key name used to sign the transaction
#   DEPOSIT_AMOUNT   — amount to deposit in stroops (1 USDC = 10_000_000)
#   RECEIVER_ADDRESS — address that receives vault shares (defaults to DEPOSITOR)
#   NETWORK          — stellar network (default: testnet)
#
# Flow:
#   1. Approve the vault contract to spend DEPOSIT_AMOUNT of the asset
#      (calls the SEP-41 `approve` function on the asset contract)
#   2. Call `deposit` on the vault contract
#
# Pre-requisite:
#   The depositor account must be KYC-verified via zkMe before the vault
#   will accept a deposit. See the zkMe integration docs for onboarding.
#
# Note on testnet USDC:
#   If you need testnet USDC, use the Stellar Lab or the Circle USDC
#   faucet, or mint test tokens using a SAC (Stellar Asset Contract).
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$SCRIPT_DIR/../soroban-contracts"
ENV_FILE="$CONTRACT_DIR/.env.testnet"

NETWORK="${NETWORK:-testnet}"
NON_INTERACTIVE=false
[[ "${1:-}" == "--non-interactive" ]] && NON_INTERACTIVE=true

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()    { echo "[INFO]  $*"; }
success() { echo "[OK]    $*"; }
die()     { echo "[ERROR] $*" >&2; exit 1; }

prompt() {
    local var_name="$1"
    local prompt_text="$2"
    local default="${3:-}"

    if [[ -n "${!var_name:-}" ]]; then
        return
    fi

    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        [[ -n "$default" ]] && eval "$var_name='$default'" && return
        die "Required variable '$var_name' not set and running non-interactively."
    fi

    local display_default=""
    [[ -n "$default" ]] && display_default=" [$default]"

    read -rp "${prompt_text}${display_default}: " value
    value="${value:-$default}"
    [[ -z "$value" ]] && die "'$var_name' cannot be empty."
    eval "$var_name='$value'"
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

command -v stellar >/dev/null 2>&1 || die "'stellar' CLI not found. Install with: cargo install --locked stellar-cli"

# Load previously saved deployment environment
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE" && info "Loaded config from $ENV_FILE"

# ---------------------------------------------------------------------------
# Gather parameters
# ---------------------------------------------------------------------------

echo ""
echo "=== Fund StellarYield Vault ==="
echo ""

prompt VAULT_ADDRESS    "Vault contract ID"
prompt ASSET            "Deposit asset contract ID" "${DEFAULT_ASSET:-}"
prompt DEPOSITOR        "Depositor Stellar address (G...) — must be KYC-verified"
prompt SOURCE_ACCOUNT   "Stellar CLI key name for signing" "default"
prompt DEPOSIT_AMOUNT   "Deposit amount in stroops (1 USDC = 10000000)" "100000000"
RECEIVER_ADDRESS="${RECEIVER_ADDRESS:-$DEPOSITOR}"
prompt RECEIVER_ADDRESS "Receiver address for vault shares" "$DEPOSITOR"

# Approve expiry — current ledger + ~30 days worth of ledgers (5s per ledger)
# Approximate: 30 * 24 * 3600 / 5 = 518400 ledgers ahead
EXPIRY_LEDGER="${EXPIRY_LEDGER:-}"
if [[ -z "$EXPIRY_LEDGER" ]]; then
    LATEST_LEDGER=$(stellar network status --network "$NETWORK" 2>/dev/null | grep -oP 'Latest Ledger Sequence: \K[0-9]+' || echo "")
    if [[ -n "$LATEST_LEDGER" ]]; then
        EXPIRY_LEDGER=$(( LATEST_LEDGER + 518400 ))
    else
        # Fallback: prompt user
        prompt EXPIRY_LEDGER "Allowance expiry ledger number (run 'stellar network status' to get current)"
    fi
fi

echo ""
info "Vault:          $VAULT_ADDRESS"
info "Asset:          $ASSET"
info "Depositor:      $DEPOSITOR"
info "Receiver:       $RECEIVER_ADDRESS"
info "Network:        $NETWORK"
info "Source account: $SOURCE_ACCOUNT"
info "Deposit:        $DEPOSIT_AMOUNT stroops"
info "Allowance expiry ledger: $EXPIRY_LEDGER"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Approve vault to spend the deposit amount
# ---------------------------------------------------------------------------

info "Step 1/2 — Approving vault to spend $DEPOSIT_AMOUNT stroops of asset..."

stellar contract invoke \
    --id "$ASSET" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- approve \
    --from    "$DEPOSITOR" \
    --spender "$VAULT_ADDRESS" \
    --amount  "$DEPOSIT_AMOUNT" \
    --expiration_ledger "$EXPIRY_LEDGER"

success "Approval granted."

# ---------------------------------------------------------------------------
# Step 2: Deposit into vault
# ---------------------------------------------------------------------------

info "Step 2/2 — Depositing into vault..."

stellar contract invoke \
    --id "$VAULT_ADDRESS" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- deposit \
    --caller   "$DEPOSITOR" \
    --assets   "$DEPOSIT_AMOUNT" \
    --receiver "$RECEIVER_ADDRESS"

success "Deposit complete."

# ---------------------------------------------------------------------------
# Query resulting share balance
# ---------------------------------------------------------------------------

SHARES=$(stellar contract invoke \
    --id "$VAULT_ADDRESS" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- balance \
    --id "$RECEIVER_ADDRESS" 2>/dev/null || echo "unknown")

echo ""
echo "============================================================"
echo "  Deposit complete!"
echo "============================================================"
echo "  Vault:            $VAULT_ADDRESS"
echo "  Deposited:        $DEPOSIT_AMOUNT stroops"
echo "  Receiver:         $RECEIVER_ADDRESS"
echo "  Share balance:    $SHARES"
echo ""
echo "  Useful follow-up commands:"
echo ""
echo "  # Check pending yield"
echo "  stellar contract invoke --id $VAULT_ADDRESS \\"
echo "    --source-account $SOURCE_ACCOUNT --network $NETWORK \\"
echo "    -- pending_yield --user $RECEIVER_ADDRESS"
echo ""
echo "  # Claim yield"
echo "  stellar contract invoke --id $VAULT_ADDRESS \\"
echo "    --source-account $SOURCE_ACCOUNT --network $NETWORK \\"
echo "    -- claim_yield --caller $RECEIVER_ADDRESS"
echo "============================================================"
