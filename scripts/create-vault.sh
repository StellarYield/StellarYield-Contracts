#!/usr/bin/env bash
# =============================================================================
# create-vault.sh — Create a SingleRWA vault through the deployed VaultFactory
#
# Usage:
#   ./scripts/create-vault.sh [--non-interactive]
#
# Environment variables (all prompted if not set):
#   FACTORY_ADDRESS  — contract ID of the deployed vault factory
#   SOURCE_ACCOUNT   — stellar-cli key name used to sign the transaction
#   OPERATOR_ADDRESS — Stellar address granted operator role on the new vault
#   ASSET            — contract ID of the deposit asset (defaults to DEFAULT_ASSET)
#   VAULT_NAME       — display name, e.g. "US Treasury 6-Month Bill"
#   VAULT_SYMBOL     — share token symbol, e.g. "syUSTB"
#   RWA_NAME         — underlying asset name, e.g. "US Treasury 6-Month Bill"
#   RWA_SYMBOL       — underlying asset symbol, e.g. "USTB6M"
#   RWA_DOCUMENT_URI — IPFS or HTTPS link to the RWA document
#   MATURITY_DATE    — Unix timestamp (seconds) for vault maturity
#   FUNDING_TARGET   — minimum deposit amount (in stroops) to activate the vault
#   MAX_DEPOSIT      — per-user deposit cap (in stroops); 0 = unlimited
#   EXIT_FEE_BPS     — early-redemption fee in basis points (e.g. 100 = 1%)
#   NETWORK          — stellar network (default: testnet)
#
# Pre-requisite:
#   Run deploy-testnet.sh first; this script sources .env.testnet automatically.
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
echo "=== Create StellarYield Vault ==="
echo ""

prompt FACTORY_ADDRESS  "VaultFactory contract ID"
prompt SOURCE_ACCOUNT   "Stellar CLI key name" "default"
prompt OPERATOR_ADDRESS "Operator Stellar address (G...)" "${ADMIN_ADDRESS:-}"
prompt ASSET            "Deposit asset contract ID" "${DEFAULT_ASSET:-}"
prompt VAULT_NAME       "Vault display name" "US Treasury 6-Month Bill"
prompt VAULT_SYMBOL     "Vault share token symbol" "syUSTB"
prompt RWA_NAME         "RWA underlying asset name" "$VAULT_NAME"
prompt RWA_SYMBOL       "RWA underlying asset symbol" "USTB6M"
prompt RWA_DOCUMENT_URI "RWA document URI (IPFS or HTTPS)" "ipfs://bafybeib..."
prompt MATURITY_DATE    "Maturity date (Unix timestamp, seconds)"
prompt FUNDING_TARGET   "Funding target in stroops (1 USDC = 10000000)" "1000000000"
prompt MAX_DEPOSIT      "Per-user deposit cap in stroops (0 = unlimited)" "0"
prompt EXIT_FEE_BPS     "Early-redemption exit fee in basis points" "100"

# Default epoch duration to 30 days in seconds
EPOCH_DURATION="${EPOCH_DURATION:-2592000}"

echo ""
info "Factory:        $FACTORY_ADDRESS"
info "Network:        $NETWORK"
info "Source account: $SOURCE_ACCOUNT"
info "Operator:       $OPERATOR_ADDRESS"
info "Asset:          $ASSET"
info "Vault name:     $VAULT_NAME ($VAULT_SYMBOL)"
info "RWA:            $RWA_NAME ($RWA_SYMBOL)"
info "Document URI:   $RWA_DOCUMENT_URI"
info "Maturity date:  $MATURITY_DATE  ($(date -d "@$MATURITY_DATE" '+%Y-%m-%d' 2>/dev/null || date -r "$MATURITY_DATE" '+%Y-%m-%d' 2>/dev/null || echo 'date conversion unavailable'))"
info "Funding target: $FUNDING_TARGET stroops"
info "Max deposit:    $MAX_DEPOSIT stroops (0 = unlimited)"
info "Exit fee:       ${EXIT_FEE_BPS} bps"
echo ""

# ---------------------------------------------------------------------------
# Invoke factory
# ---------------------------------------------------------------------------

info "Invoking create_single_rwa_vault on factory..."

VAULT_ADDRESS=$(stellar contract invoke \
    --id "$FACTORY_ADDRESS" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- create_single_rwa_vault \
    --caller        "$OPERATOR_ADDRESS" \
    --asset         "$ASSET" \
    --name          "$VAULT_NAME" \
    --symbol        "$VAULT_SYMBOL" \
    --rwa_name      "$RWA_NAME" \
    --rwa_symbol    "$RWA_SYMBOL" \
    --rwa_document_uri "$RWA_DOCUMENT_URI" \
    --maturity_date "$MATURITY_DATE" \
    --funding_target "$FUNDING_TARGET" \
    --max_deposit_per_user "$MAX_DEPOSIT" \
    --exit_fee_bps  "$EXIT_FEE_BPS" \
    --epoch_duration_seconds "$EPOCH_DURATION")

[[ -z "$VAULT_ADDRESS" ]] && die "Vault creation failed — no address returned."
success "Vault deployed at: $VAULT_ADDRESS"

# Append to env file
if [[ -f "$ENV_FILE" ]]; then
    {
        echo ""
        echo "# Vault created $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
        echo "export VAULT_ADDRESS=\"$VAULT_ADDRESS\""
    } >> "$ENV_FILE"
fi

echo ""
echo "============================================================"
echo "  Vault creation complete!"
echo "============================================================"
echo "  VAULT_ADDRESS = $VAULT_ADDRESS"
echo ""
echo "  Next steps:"
echo "    1. Grant operator role on the vault:"
echo "       stellar contract invoke --id $VAULT_ADDRESS \\"
echo "         --source-account $SOURCE_ACCOUNT --network $NETWORK \\"
echo "         -- set_operator --caller $OPERATOR_ADDRESS \\"
echo "         --operator $OPERATOR_ADDRESS --status true"
echo ""
echo "    2. Fund the vault with test tokens:"
echo "       VAULT_ADDRESS=$VAULT_ADDRESS ./scripts/fund-vault.sh"
echo "============================================================"
