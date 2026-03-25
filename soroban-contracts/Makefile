# StellarYield Soroban Contracts — Build Automation
#
# Prerequisites:
#   cargo, stellar-cli (cargo install --locked stellar-cli)
#
# Common usage:
#   make build          — compile all contracts
#   make test           — run the full test suite
#   make all            — build + test + lint + fmt check
#   make ci             — full CI pipeline
#   make deploy-testnet — deploy contracts to Stellar testnet
#   make bindings       — generate TypeScript bindings

.DEFAULT_GOAL := build

# ---------------------------------------------------------------------------
# Configuration — override on the command line or via environment variables
# ---------------------------------------------------------------------------

# Network to target for deployment targets
NETWORK          ?= testnet
# Stellar account key name (from `stellar keys ls`) used to sign transactions
SOURCE_ACCOUNT   ?= default
# Output directory for generated TypeScript bindings
BINDINGS_DIR     ?= ../bindings

# Paths
WASM_DIR         := target/wasm32v1-none/release
VAULT_WASM       := $(WASM_DIR)/single_rwa_vault.wasm
FACTORY_WASM     := $(WASM_DIR)/vault_factory.wasm
SCRIPTS_DIR      := ../scripts

# Deployment param defaults (override as needed)
ADMIN_ADDRESS      ?=
DEFAULT_ASSET      ?=
ZKME_VERIFIER      ?=
COOPERATOR         ?=
FACTORY_ADDRESS    ?=

# ---------------------------------------------------------------------------
# Core build targets
# ---------------------------------------------------------------------------

## build: compile all contracts (release WASM)
.PHONY: build
build:
	stellar contract build

## build-debug: compile all contracts in debug mode
.PHONY: build-debug
build-debug:
	cargo build --target wasm32v1-none

## test: run the full workspace test suite
.PHONY: test
test:
	cargo test --workspace

## test-verbose: run tests with output captured and printed
.PHONY: test-verbose
test-verbose:
	cargo test --workspace -- --nocapture

## lint: run clippy with warnings treated as errors
.PHONY: lint
lint:
	cargo clippy --workspace -- -D warnings

## fmt: check formatting (non-destructive)
.PHONY: fmt
fmt:
	cargo fmt --check

## fmt-fix: auto-format all source files
.PHONY: fmt-fix
fmt-fix:
	cargo fmt

## clean: remove build artifacts
.PHONY: clean
clean:
	cargo clean

# ---------------------------------------------------------------------------
# WASM optimisation & inspection
# ---------------------------------------------------------------------------

## optimize: run stellar contract optimize on compiled WASMs
.PHONY: optimize
optimize: build
	stellar contract optimize --wasm $(VAULT_WASM)
	stellar contract optimize --wasm $(FACTORY_WASM)

## wasm-size: report compiled WASM file sizes
.PHONY: wasm-size
wasm-size: build
	@echo "=== WASM sizes (unoptimized) ==="
	@du -sh $(VAULT_WASM)   2>/dev/null || echo "  single_rwa_vault.wasm not found — run 'make build' first"
	@du -sh $(FACTORY_WASM) 2>/dev/null || echo "  vault_factory.wasm not found — run 'make build' first"
	@if ls $(WASM_DIR)/*.optimized.wasm 1>/dev/null 2>&1; then \
		echo ""; \
		echo "=== WASM sizes (optimized) ==="; \
		du -sh $(WASM_DIR)/*.optimized.wasm; \
	fi

# ---------------------------------------------------------------------------
# TypeScript bindings
# ---------------------------------------------------------------------------

## bindings: generate TypeScript bindings for all contracts
.PHONY: bindings
bindings: build
	@mkdir -p $(BINDINGS_DIR)/single-rwa-vault $(BINDINGS_DIR)/vault-factory
	stellar contract bindings typescript \
		--wasm $(VAULT_WASM) \
		--output-dir $(BINDINGS_DIR)/single-rwa-vault \
		--overwrite
	stellar contract bindings typescript \
		--wasm $(FACTORY_WASM) \
		--output-dir $(BINDINGS_DIR)/vault-factory \
		--overwrite
	@echo "TypeScript bindings written to $(BINDINGS_DIR)/"

# ---------------------------------------------------------------------------
# Deployment targets
# ---------------------------------------------------------------------------

## deploy-testnet: upload WASMs and deploy factory to testnet (interactive)
.PHONY: deploy-testnet
deploy-testnet: build
	@bash $(SCRIPTS_DIR)/deploy-testnet.sh

## deploy-vault: create a vault through the deployed factory (interactive)
.PHONY: deploy-vault
deploy-vault:
	@bash $(SCRIPTS_DIR)/create-vault.sh

# ---------------------------------------------------------------------------
# Composite targets
# ---------------------------------------------------------------------------

## all: build, test, lint, and check formatting
.PHONY: all
all: build test lint fmt

## ci: full CI pipeline — same as 'all' but explicit sequencing for clarity
.PHONY: ci
ci:
	@echo ">>> [1/4] Building contracts..."
	$(MAKE) build
	@echo ""
	@echo ">>> [2/4] Running tests..."
	$(MAKE) test
	@echo ""
	@echo ">>> [3/4] Running clippy..."
	$(MAKE) lint
	@echo ""
	@echo ">>> [4/4] Checking formatting..."
	$(MAKE) fmt
	@echo ""
	@echo "CI pipeline passed."

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

## help: list all available targets with descriptions
.PHONY: help
help:
	@echo "StellarYield — available make targets:"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /' | column -t -s ':'
