#!/usr/bin/env bash
# =============================================================================
# deploy-testnet.sh — Interactive testnet deployment for StellarYield contracts
#
# Usage:
#   ./scripts/deploy-testnet.sh [--non-interactive]
#
# Environment variables (all prompted if not set):
#   SOURCE_ACCOUNT   — stellar-cli key name (from `stellar keys ls`)
#   ADMIN_ADDRESS    — Stellar address for the factory admin role
#   DEFAULT_ASSET    — Contract ID of the default deposit asset (e.g. USDC)
#   ZKME_VERIFIER    — Contract ID of the zkMe verifier contract
#   COOPERATOR       — Stellar address for the zkMe cooperator
#
# Outputs:
#   VAULT_WASM_HASH  — hash of the uploaded single_rwa_vault WASM
#   FACTORY_ADDRESS  — contract ID of the deployed vault factory
#
# The script writes these values to .env.testnet in the soroban-contracts/
# directory so subsequent scripts can source them.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/soroban-contracts"
ENV_FILE="$CONTRACT_DIR/.env.testnet"

# Cargo workspace root is the repository root; WASMs land under repo `target/`.
WASM_DIR="$REPO_ROOT/target/wasm32v1-none/release"
VAULT_WASM="$WASM_DIR/single_rwa_vault.wasm"
FACTORY_WASM="$WASM_DIR/vault_factory.wasm"

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
    local value

    if [[ -n "${!var_name:-}" ]]; then
        return
    fi

    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        [[ -n "$default" ]] && printf -v "$var_name" '%s' "$default" && return
        die "Required variable '$var_name' not set and running non-interactively."
    fi

    local display_default=""
    [[ -n "$default" ]] && display_default=" [$default]"

    read -rp "${prompt_text}${display_default}: " value
    value="${value:-$default}"
    [[ -z "$value" ]] && die "'$var_name' cannot be empty."
    printf -v "$var_name" '%s' "$value"
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

command -v stellar >/dev/null 2>&1 || die "'stellar' CLI not found. Install with: cargo install --locked stellar-cli"

# Load previously saved environment if it exists
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE" && info "Loaded existing config from $ENV_FILE"

# ---------------------------------------------------------------------------
# Gather parameters
# ---------------------------------------------------------------------------

echo ""
echo "=== StellarYield Testnet Deployment ==="
echo ""

prompt SOURCE_ACCOUNT  "Stellar CLI key name (run 'stellar keys ls' to see options)" "default"
prompt ADMIN_ADDRESS   "Admin Stellar address (G...)"
prompt DEFAULT_ASSET   "Default deposit asset contract ID (e.g. USDC on testnet)"
prompt ZKME_VERIFIER   "zkMe verifier contract ID"
prompt COOPERATOR      "zkMe cooperator Stellar address"

echo ""
info "Network:        $NETWORK"
info "Source account: $SOURCE_ACCOUNT"
info "Admin:          $ADMIN_ADDRESS"
info "Default asset:  $DEFAULT_ASSET"
info "zkMe verifier:  $ZKME_VERIFIER"
info "Cooperator:     $COOPERATOR"
echo ""

# ---------------------------------------------------------------------------
# Build (if WASMs are missing)
# ---------------------------------------------------------------------------

if [[ ! -f "$VAULT_WASM" || ! -f "$FACTORY_WASM" ]]; then
    info "WASM files not found — running 'make build'..."
    (cd "$CONTRACT_DIR" && make build)
fi

info "WASM files ready:"
ls -lh "$VAULT_WASM" "$FACTORY_WASM"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Upload single_rwa_vault WASM
# ---------------------------------------------------------------------------

info "Uploading single_rwa_vault WASM to $NETWORK..."
VAULT_WASM_HASH=$(stellar contract upload \
    --wasm "$VAULT_WASM" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK")

[[ -z "$VAULT_WASM_HASH" ]] && die "Failed to upload single_rwa_vault WASM."
success "Vault WASM hash: $VAULT_WASM_HASH"

# ---------------------------------------------------------------------------
# Step 2: Deploy vault_factory
# ---------------------------------------------------------------------------

info "Deploying vault_factory to $NETWORK..."
FACTORY_ADDRESS=$(stellar contract deploy \
    --wasm "$FACTORY_WASM" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- \
    --admin        "$ADMIN_ADDRESS" \
    --default_asset  "$DEFAULT_ASSET" \
    --zkme_verifier  "$ZKME_VERIFIER" \
    --cooperator     "$COOPERATOR" \
    --vault_wasm_hash "$VAULT_WASM_HASH")

[[ -z "$FACTORY_ADDRESS" ]] && die "Failed to deploy vault_factory."
success "Factory deployed at: $FACTORY_ADDRESS"

# ---------------------------------------------------------------------------
# Persist results
# ---------------------------------------------------------------------------

cat > "$ENV_FILE" <<EOF
# Auto-generated by deploy-testnet.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
export NETWORK="$NETWORK"
export SOURCE_ACCOUNT="$SOURCE_ACCOUNT"
export ADMIN_ADDRESS="$ADMIN_ADDRESS"
export DEFAULT_ASSET="$DEFAULT_ASSET"
export ZKME_VERIFIER="$ZKME_VERIFIER"
export COOPERATOR="$COOPERATOR"
export VAULT_WASM_HASH="$VAULT_WASM_HASH"
export FACTORY_ADDRESS="$FACTORY_ADDRESS"
EOF

echo ""
echo "============================================================"
echo "  Deployment complete!"
echo "============================================================"
echo "  VAULT_WASM_HASH  = $VAULT_WASM_HASH"
echo "  FACTORY_ADDRESS  = $FACTORY_ADDRESS"
echo ""
echo "  Config saved to: $ENV_FILE"
echo "  Source it with:  source $ENV_FILE"
echo ""
echo "  Next: create a vault with  ./scripts/create-vault.sh"
echo "============================================================"
