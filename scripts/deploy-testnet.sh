#!/usr/bin/env bash
# =============================================================================
# deploy-testnet.sh — Interactive testnet deployment for StellarYield contracts
#
# Usage:
#   ./scripts/deploy-testnet.sh [--non-interactive] [--dry-run]
#   ./scripts/deploy-testnet.sh --help
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

source "$SCRIPT_DIR/lib/common.sh"

NETWORK="${NETWORK:-testnet}"
NON_INTERACTIVE=false
DRY_RUN=false

usage() {
    cat <<EOF
Usage: ./scripts/deploy-testnet.sh [--non-interactive] [--dry-run]
       ./scripts/deploy-testnet.sh --help

Deploys the vault WASM and vault factory to the selected Stellar network.

Required environment variables (prompted if not set):
  SOURCE_ACCOUNT   Stellar CLI key name used to sign (default: default)
  ADMIN_ADDRESS    Stellar address for the factory admin role
  DEFAULT_ASSET    Contract ID of the default deposit asset
  ZKME_VERIFIER    Contract ID of the zkMe verifier contract
  COOPERATOR       Stellar address for the zkMe cooperator

Optional environment variables:
  NETWORK          Stellar network (default: testnet)

Options:
  --non-interactive  Fail instead of prompting for missing variables.
  --dry-run          Print each stellar command without executing it.
  -h, --help         Show this message and exit.

Example:
  SOURCE_ACCOUNT=deployer ADMIN_ADDRESS=G... DEFAULT_ASSET=C... \\
    ZKME_VERIFIER=C... COOPERATOR=G... ./scripts/deploy-testnet.sh --non-interactive
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --non-interactive) NON_INTERACTIVE=true ;;
        --dry-run) DRY_RUN=true ;;
        *) die "Unknown option '$1'. Try --help." ;;
    esac
    shift
done

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

print_stellar() {
    printf 'stellar'
    printf ' %q' "$@"
    printf '\n'
}

dry_run_wasm_hash() {
    local hash=""
    if [[ -f "$VAULT_WASM" ]]; then
        if command -v sha256sum >/dev/null 2>&1; then
            read -r hash _ < <(sha256sum "$VAULT_WASM")
        elif command -v shasum >/dev/null 2>&1; then
            hash="$(shasum -a 256 "$VAULT_WASM")"
            hash="${hash%% *}"
        fi
    fi
    printf '%s' "${hash:-dry-run-vault-wasm-hash}"
}

# ---------------------------------------------------------------------------
# Build (if WASMs are missing)
# ---------------------------------------------------------------------------

if [[ ! -f "$VAULT_WASM" || ! -f "$FACTORY_WASM" ]]; then
    if [[ "$DRY_RUN" == "true" ]]; then
        info "WASM files not found — would run 'make build' (skipped in dry-run)."
    else
        info "WASM files not found — running 'make build'..."
        (cd "$CONTRACT_DIR" && make build)
    fi
fi

if [[ "$DRY_RUN" == "true" ]]; then
    info "WASM paths ready:"
    info "  $VAULT_WASM"
    info "  $FACTORY_WASM"
else
    info "WASM files ready:"
    ls -lh "$VAULT_WASM" "$FACTORY_WASM"
fi
echo ""

# ---------------------------------------------------------------------------
# Step 1: Upload single_rwa_vault WASM
# ---------------------------------------------------------------------------

info "Uploading single_rwa_vault WASM to $NETWORK..."
UPLOAD_ARGS=(contract upload
    --wasm "$VAULT_WASM"
    --source-account "$SOURCE_ACCOUNT"
    --network "$NETWORK")

if [[ "$DRY_RUN" == "true" ]]; then
    print_stellar "${UPLOAD_ARGS[@]}"
    VAULT_WASM_HASH="$(dry_run_wasm_hash)"
else
    VAULT_WASM_HASH=$(stellar "${UPLOAD_ARGS[@]}")
fi

[[ -z "$VAULT_WASM_HASH" ]] && die "Failed to upload single_rwa_vault WASM."
success "Vault WASM hash: $VAULT_WASM_HASH"

# ---------------------------------------------------------------------------
# Step 2: Deploy vault_factory
# ---------------------------------------------------------------------------

info "Deploying vault_factory to $NETWORK..."
DEPLOY_ARGS=(contract deploy
    --wasm "$FACTORY_WASM"
    --source-account "$SOURCE_ACCOUNT"
    --network "$NETWORK"
    --
    --admin "$ADMIN_ADDRESS"
    --default_asset "$DEFAULT_ASSET"
    --zkme_verifier "$ZKME_VERIFIER"
    --cooperator "$COOPERATOR"
    --vault_wasm_hash "$VAULT_WASM_HASH")

if [[ "$DRY_RUN" == "true" ]]; then
    print_stellar "${DEPLOY_ARGS[@]}"
    FACTORY_ADDRESS="dry-run-factory-address"
else
    FACTORY_ADDRESS=$(stellar "${DEPLOY_ARGS[@]}")
fi

[[ -z "$FACTORY_ADDRESS" ]] && die "Failed to deploy vault_factory."
success "Factory deployed at: $FACTORY_ADDRESS"

# ---------------------------------------------------------------------------
# Persist results
# ---------------------------------------------------------------------------

if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "============================================================"
    echo "  Dry run complete!"
    echo "============================================================"
    echo "  No stellar commands were executed and no files were changed."
    echo "  VAULT_WASM_HASH  = $VAULT_WASM_HASH"
    echo "  FACTORY_ADDRESS  = $FACTORY_ADDRESS (placeholder)"
    echo "============================================================"
    exit 0
fi

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
