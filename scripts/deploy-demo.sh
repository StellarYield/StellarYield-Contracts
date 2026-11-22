#!/usr/bin/env bash
# =============================================================================
# deploy-demo.sh — One-command testnet setup for the frontend demo.
#
# Does everything DEPLOYMENT.md describes step by step:
#   1. build contracts            5. create a vault (funding target + min deposit)
#   2. create + fund a deployer   6. open KYC and grant the operator role
#   3. issue a demo USDC token    7. write frontend/.env
#   4. deploy the vault factory
#
# Usage:
#   ./scripts/deploy-demo.sh
#   ./scripts/deploy-demo.sh --help
#
# Optional environment variables (all have working defaults):
#   NETWORK          stellar network                      (default: testnet)
#   SOURCE_ACCOUNT   stellar-cli key name for the deployer(default: sy-deployer)
#   ISSUER_ACCOUNT   stellar-cli key name for the demo token issuer (default: sy-usdc-issuer)
#   ASSET            existing SEP-41 token contract ID    (default: issue a demo USDC)
#   DEMO_ACCOUNT     extra G... address to fund + make operator (default: none)
#   VAULT_NAME / VAULT_SYMBOL / RWA_NAME / RWA_SYMBOL / RWA_CATEGORY
#   RWA_DOCUMENT_URI / EXPECTED_APY_BPS / FUNDING_TARGET / MIN_DEPOSIT
#   MAX_DEPOSIT_PER_USER / EXIT_FEE_BPS / MATURITY_DAYS / FUNDING_DEADLINE_DAYS
#   MINT_AMOUNT      demo token amount in smallest units   (default: 100000000000)
#
# Re-running is safe: existing keys are reused rather than regenerated.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONTRACT_DIR="$REPO_ROOT/soroban-contracts"
ENV_FILE="$CONTRACT_DIR/.env.demo"
FRONTEND_ENV="$REPO_ROOT/frontend/.env"

source "$SCRIPT_DIR/lib/common.sh"

NETWORK="${NETWORK:-testnet}"
SOURCE_ACCOUNT="${SOURCE_ACCOUNT:-sy-deployer}"
ISSUER_ACCOUNT="${ISSUER_ACCOUNT:-sy-usdc-issuer}"

# Vault parameters. Amounts are in the asset's smallest unit (SAC = 7 decimals).
VAULT_NAME="${VAULT_NAME:-US Treasury 6-Month Bill}"
VAULT_SYMBOL="${VAULT_SYMBOL:-syUSTB}"
RWA_NAME="${RWA_NAME:-$VAULT_NAME}"
RWA_SYMBOL="${RWA_SYMBOL:-USTB6M}"
RWA_CATEGORY="${RWA_CATEGORY:-Government Debt}"
RWA_DOCUMENT_URI="${RWA_DOCUMENT_URI:-ipfs://bafybeibexampledocumenthash}"
EXPECTED_APY_BPS="${EXPECTED_APY_BPS:-512}"          # 5.12%
FUNDING_TARGET="${FUNDING_TARGET:-1000000000}"       # 100 USDC
MIN_DEPOSIT="${MIN_DEPOSIT:-10000000}"               # 1 USDC
MAX_DEPOSIT_PER_USER="${MAX_DEPOSIT_PER_USER:-0}"    # 0 = uncapped
EXIT_FEE_BPS="${EXIT_FEE_BPS:-200}"                  # 2%
MATURITY_DAYS="${MATURITY_DAYS:-90}"
FUNDING_DEADLINE_DAYS="${FUNDING_DEADLINE_DAYS:-7}"
MINT_AMOUNT="${MINT_AMOUNT:-100000000000}"           # 10,000 USDC

usage() {
    cat <<EOF
Usage: ./scripts/deploy-demo.sh
       ./scripts/deploy-demo.sh --help

Builds and deploys a complete testnet demo: deployer key, demo asset, factory,
vault, KYC bypass, operator role, and frontend/.env.

Required environment variables:
  None. Every value has a working default.

Optional environment variables:
  NETWORK               Stellar network (default: testnet)
  SOURCE_ACCOUNT        Stellar CLI key name for the deployer (default: sy-deployer)
  ISSUER_ACCOUNT        Stellar CLI key name for the demo asset issuer (default: sy-usdc-issuer)
  ASSET                 Existing SEP-41 token contract ID (default: issue a demo USDC)
  DEMO_ACCOUNT          Extra G... address to fund and make an operator (default: none)
  VAULT_NAME            Vault display name (default: US Treasury 6-Month Bill)
  VAULT_SYMBOL          Vault share token symbol (default: syUSTB)
  RWA_NAME              Underlying asset name (default: VAULT_NAME)
  RWA_SYMBOL            Underlying asset symbol (default: USTB6M)
  RWA_CATEGORY          Underlying asset category (default: Government Debt)
  RWA_DOCUMENT_URI      IPFS or HTTPS RWA document URI
  EXPECTED_APY_BPS      Expected APY in basis points (default: 512)
  FUNDING_TARGET        Funding target in stroops (default: 1000000000)
  MIN_DEPOSIT           Minimum deposit in stroops (default: 10000000)
  MAX_DEPOSIT_PER_USER  Per-user deposit cap in stroops (default: 0)
  EXIT_FEE_BPS          Early-redemption fee in basis points (default: 200)
  MATURITY_DAYS         Vault maturity in days from now (default: 90)
  FUNDING_DEADLINE_DAYS Funding deadline in days from now (default: 7)
  MINT_AMOUNT           Demo token amount in smallest units (default: 100000000000)

Options:
  -h, --help  Show this message and exit.

Example:
  DEMO_ACCOUNT=G... NETWORK=testnet ./scripts/deploy-demo.sh
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option '$1'. Try --help." ;;
    esac
    shift
done

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

command -v stellar >/dev/null 2>&1 \
  || die "'stellar' CLI not found. Install: cargo install --locked stellar-cli"

info "stellar CLI: $(stellar --version | head -1)"
info "Network:     $NETWORK"
echo ""

# Reuse an existing key if present, otherwise generate and fund one.
ensure_key() {
    local name="$1"
    if stellar keys address "$name" >/dev/null 2>&1; then
        info "Reusing existing key '$name'"
    else
        info "Generating and funding key '$name'..."
        # stellar-cli >= 23 dropped `--global`; identities are global by default.
        stellar keys generate "$name" --network "$NETWORK" --fund
    fi
}

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------

WASM_DIR="$REPO_ROOT/target/wasm32v1-none/release"
if [[ ! -f "$WASM_DIR/single_rwa_vault.wasm" || ! -f "$WASM_DIR/vault_factory.wasm" ]]; then
    info "Building contracts..."
    (cd "$CONTRACT_DIR" && make build)
fi
success "WASM ready"

# ---------------------------------------------------------------------------
# 2. Deployer identity
# ---------------------------------------------------------------------------

ensure_key "$SOURCE_ACCOUNT"
ADMIN="$(stellar keys address "$SOURCE_ACCOUNT")"
success "Deployer / admin: $ADMIN"

# ---------------------------------------------------------------------------
# 3. Demo asset
# ---------------------------------------------------------------------------

if [[ -n "${ASSET:-}" ]]; then
    info "Using supplied asset: $ASSET"
    SKIP_MINT=true
else
    ensure_key "$ISSUER_ACCOUNT"
    ISSUER="$(stellar keys address "$ISSUER_ACCOUNT")"
    info "Deploying Stellar Asset Contract for USDC:$ISSUER..."

    # Idempotent: `asset deploy` fails if it already exists, so fall back to the
    # deterministic contract id for that asset.
    stellar contract asset deploy \
        --asset "USDC:$ISSUER" \
        --source-account "$SOURCE_ACCOUNT" \
        --network "$NETWORK" >/dev/null 2>&1 || true

    ASSET="$(stellar contract id asset --asset "USDC:$ISSUER" --network "$NETWORK")"
    SKIP_MINT=false
fi
success "Asset: $ASSET"

if [[ "$SKIP_MINT" == "false" ]]; then
    # A SAC settles G-addresses through classic trustlines, so the deployer needs
    # one before it can hold USDC. Harmless if it already exists.
    info "Adding USDC trustline for the deployer..."
    stellar tx new change-trust \
        --source-account "$SOURCE_ACCOUNT" \
        --line "USDC:$ISSUER" \
        --network "$NETWORK" >/dev/null 2>&1 \
        || info "  (trustline already present, or unsupported CLI version — continuing)"

    info "Minting demo USDC to the deployer..."
    stellar contract invoke \
        --id "$ASSET" \
        --source-account "$ISSUER_ACCOUNT" \
        --network "$NETWORK" \
        -- mint --to "$ADMIN" --amount "$MINT_AMOUNT"
    success "Minted $MINT_AMOUNT (smallest unit) to $ADMIN"
fi

# ---------------------------------------------------------------------------
# 4. Factory
# ---------------------------------------------------------------------------

info "Uploading vault WASM..."
VAULT_WASM_HASH="$(stellar contract upload \
    --wasm "$WASM_DIR/single_rwa_vault.wasm" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK")"
success "Vault WASM hash: $VAULT_WASM_HASH"

info "Deploying vault factory..."
# zkme_verifier is a placeholder — step 6 disables the KYC check on the vault.
FACTORY_ADDRESS="$(stellar contract deploy \
    --wasm "$WASM_DIR/vault_factory.wasm" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- \
    --admin "$ADMIN" \
    --default_asset "$ASSET" \
    --zkme_verifier "$ADMIN" \
    --cooperator "$ADMIN" \
    --vault_wasm_hash "$VAULT_WASM_HASH")"
success "Factory: $FACTORY_ADDRESS"

# ---------------------------------------------------------------------------
# 5. Vault
# ---------------------------------------------------------------------------

NOW="$(date +%s)"
MATURITY=$(( NOW + MATURITY_DAYS * 86400 ))
DEADLINE=$(( NOW + FUNDING_DEADLINE_DAYS * 86400 ))

info "Creating vault '$VAULT_NAME'..."
# create_single_rwa_vault_full takes the whole CreateVaultParams struct; the
# 9-arg create_single_rwa_vault cannot set a funding target or minimum deposit.
VAULT="$(stellar contract invoke \
    --id "$FACTORY_ADDRESS" \
    --source-account "$SOURCE_ACCOUNT" \
    --network "$NETWORK" \
    -- create_single_rwa_vault_full \
    --caller "$ADMIN" \
    --params "{
      \"asset\": \"$ASSET\",
      \"name\": \"$VAULT_NAME\",
      \"symbol\": \"$VAULT_SYMBOL\",
      \"rwa_name\": \"$RWA_NAME\",
      \"rwa_symbol\": \"$RWA_SYMBOL\",
      \"rwa_document_uri\": \"$RWA_DOCUMENT_URI\",
      \"rwa_category\": \"$RWA_CATEGORY\",
      \"expected_apy\": $EXPECTED_APY_BPS,
      \"maturity_date\": $MATURITY,
      \"funding_deadline\": $DEADLINE,
      \"funding_target\": \"$FUNDING_TARGET\",
      \"min_deposit\": \"$MIN_DEPOSIT\",
      \"max_deposit_per_user\": \"$MAX_DEPOSIT_PER_USER\",
      \"early_redemption_fee_bps\": $EXIT_FEE_BPS
    }")"
VAULT="$(echo "$VAULT" | tr -d '"' | tr -d '[:space:]')"
[[ -z "$VAULT" ]] && die "Vault creation returned no address."
success "Vault: $VAULT"

# ---------------------------------------------------------------------------
# 6. Open KYC + operator role
# ---------------------------------------------------------------------------

# The vault treats its own address as the "no verifier" sentinel, so pointing
# zkme_verifier at the vault makes is_kyc_verified true for everyone.
info "Disabling the KYC gate for the demo..."
stellar contract invoke --id "$VAULT" --source-account "$SOURCE_ACCOUNT" --network "$NETWORK" \
    -- set_zkme_verifier --caller "$ADMIN" --verifier "$VAULT" >/dev/null
success "KYC gate open"

info "Granting operator role to the deployer..."
stellar contract invoke --id "$VAULT" --source-account "$SOURCE_ACCOUNT" --network "$NETWORK" \
    -- set_operator --caller "$ADMIN" --operator "$ADMIN" --status true >/dev/null
success "Operator granted"

if [[ -n "${DEMO_ACCOUNT:-}" ]]; then
    info "Granting operator role to $DEMO_ACCOUNT..."
    stellar contract invoke --id "$VAULT" --source-account "$SOURCE_ACCOUNT" --network "$NETWORK" \
        -- set_operator --caller "$ADMIN" --operator "$DEMO_ACCOUNT" --status true >/dev/null

    if [[ "$SKIP_MINT" == "false" ]]; then
        info "Minting demo USDC to $DEMO_ACCOUNT (needs a USDC:$ISSUER trustline)..."
        stellar contract invoke --id "$ASSET" --source-account "$ISSUER_ACCOUNT" --network "$NETWORK" \
            -- mint --to "$DEMO_ACCOUNT" --amount "$MINT_AMOUNT" \
            || info "  Mint failed — add the USDC:$ISSUER trustline in Freighter, then retry."
    fi
fi

# ---------------------------------------------------------------------------
# 7. Persist config
# ---------------------------------------------------------------------------

cat > "$ENV_FILE" <<EOF
# Auto-generated by deploy-demo.sh — $(date -u +"%Y-%m-%dT%H:%M:%SZ")
export NETWORK="$NETWORK"
export SOURCE_ACCOUNT="$SOURCE_ACCOUNT"
export ADMIN_ADDRESS="$ADMIN"
export ASSET="$ASSET"
export VAULT_WASM_HASH="$VAULT_WASM_HASH"
export FACTORY_ADDRESS="$FACTORY_ADDRESS"
export VAULT_ADDRESS="$VAULT"
EOF

cat > "$FRONTEND_ENV" <<EOF
VITE_STELLAR_NETWORK=$NETWORK
VITE_SOROBAN_RPC_URL=https://soroban-$NETWORK.stellar.org
VITE_FACTORY_ADDRESS=$FACTORY_ADDRESS
EOF

echo ""
echo "============================================================"
echo "  Demo deployment complete"
echo "============================================================"
echo "  Asset    $ASSET"
echo "  Factory  $FACTORY_ADDRESS"
echo "  Vault    $VAULT"
echo ""
echo "  Wrote $ENV_FILE"
echo "  Wrote $FRONTEND_ENV"
echo ""
echo "  Next:"
echo "    1. Import the operator key into Freighter (Testnet):"
echo "         stellar keys show $SOURCE_ACCOUNT"
echo "    2. Start the frontend:"
echo "         cd frontend && npm install && npm run dev"
echo "    3. Follow the demo script in frontend/DEPLOYMENT.md (step 8)."
echo "============================================================"
