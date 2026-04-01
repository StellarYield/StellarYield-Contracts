# Contributing to StellarYield

Thank you for your interest in contributing to StellarYield! This guide will help you get started and ensure your contributions follow our standards.

## Table of Contents

- [Getting Started](#getting-started)
- [Architecture Overview](#architecture-overview)
- [Code Style](#code-style)
- [PR Standards](#pr-standards)
- [Testing Guide](#testing-guide)
- [Issue Workflow](#issue-workflow)
- [Security Policy](#security-policy)

## Getting Started

### Prerequisites

1. **Rust toolchain** (latest stable):
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Stellar CLI**:
   ```bash
   cargo install --locked stellar-cli
   ```

3. **WASM target**:
   ```bash
   rustup target add wasm32v1-none
   ```

4. **Node.js & npm** (for SDK development):
   ```bash
   # Install Node.js 18+ from https://nodejs.org or via your package manager
   ```

### Clone & Build

1. **Clone the repository**:
   ```bash
   git clone https://github.com/StellarYield/StellarYield-Contracts.git
   cd StellarYield-Contracts
   ```

2. **Build all contracts**:
   ```bash
   cd soroban-contracts
   make build
   ```

3. **Run the test suite**:
   ```bash
   make test
   ```

4. **Full CI pipeline (build + test + lint + format check)**:
   ```bash
   make all
   ```

### Quick Development Workflow

```bash
# Make your changes
vim soroban-contracts/contracts/single_rwa_vault/src/lib.rs

# Run tests for specific contract
cargo test -p single_rwa_vault

# Check formatting
make fmt

# Run linter
make lint

# Full check before committing
make ci
```

## Architecture Overview

### High-Level Architecture

```
┌─────────────────┐    deploys    ┌──────────────────────┐
│  VaultFactory   │ ──────────────▶ │   SingleRWA_Vault   │
│                 │                │  (Treasury Bill A)   │
│ - Registry      │                │                      │
│ - Deployment    │                │ - Share tokens       │
│ - Defaults      │                │ - Yield distribution │
└─────────────────┘                │ - KYC enforcement    │
                                     └──────────────────────┘
                                           │
                                           ▼
                                ┌──────────────────────┐
                                │   SingleRWA_Vault   │
                                │ (Corporate Bond B)  │
                                └──────────────────────┘
```

### Contract Responsibilities

#### `single_rwa_vault`
Each vault instance represents **one specific RWA investment**:

- **Share Token Management**: Issues SEP-41-compliant fungible shares
- **KYC Enforcement**: Integrates with zkMe verifier before deposits
- **Vault Lifecycle**: Manages `Funding → Active → Matured → Closed` states
- **Yield Distribution**: Epoch-based yield distribution with proportional claiming
- **Early Redemption**: Operator-approved early exit with configurable fees
- **Emergency Controls**: Pause, emergency withdrawals, and multi-sig proposals

#### `vault_factory`
Registry and deployment factory for vault instances:

- **Vault Deployment**: Deploys new `single_rwa_vault` instances using stored WASM hash
- **Registry Management**: Maintains on-chain registry of all deployed vaults
- **Batch Operations**: Supports creating multiple vaults in a single transaction
- **Default Configuration**: Manages shared defaults (asset, KYC settings, etc.)
- **Access Control**: Role-based permissions for factory operations

### Storage Design Decisions

| Storage Tier | Usage | Rationale |
|--------------|-------|-----------|
| **Instance** | Global config, vault state, epoch counters, operator registry | Must never be archived while contract is live |
| **Persistent** | Per-user balances, allowances, yield claim flags, share snapshots | Long-term user data that must survive archival |
| **Temporary** | None in this contract | All data is permanent for financial integrity |

**TTL Constants** (assuming ~5-second ledger close times):
- `INSTANCE_LIFETIME_THRESHOLD`: ~30 days
- `BALANCE_LIFETIME_THRESHOLD`: ~60 days

### Yield Distribution Model

Yield is distributed in discrete **epochs**:

1. **Operator calls `distribute_yield(amount)`**
   - Pulls `amount` of underlying asset into vault
   - Records epoch yield and total share supply at that moment
   - Increments epoch counter

2. **User share snapshots** (lazy evaluation):
   - Captured on user's first interaction after each epoch
   - Prevents gas costs for inactive users

3. **Yield calculation** for epoch `n`:
   ```
   yield_user = (shares_user_at_epoch_n / total_shares_at_epoch_n) × epoch_yield_n
   ```

4. **Claim optimization**:
   - `LastClaimedEpoch` cursor scans only new epochs
   - Batch claiming available for efficiency

## Code Style

### Formatting Rules

- Use **`cargo fmt`** for automatic formatting
- **Line length**: 100 characters maximum
- **Indentation**: 4 spaces (no tabs)
- **Trailing commas**: Required in multi-line structs/enums

### Naming Conventions

| Context | Convention | Examples |
|---------|------------|----------|
| Functions | `snake_case` | `distribute_yield`, `get_user_balance` |
| Types | `PascalCase` | `VaultState`, `InitParams`, `RedemptionRequest` |
| Constants | `SCREAMING_SNAKE_CASE` | `INSTANCE_LIFETIME_THRESHOLD`, `MAX_EPOCH_BATCH` |
| Contract Types | `PascalCase` | `SingleRWAVault`, `VaultFactory` |
| Storage Keys | `PascalCase` | `Admin`, `TotalSupply`, `UserSharesAtEpoch` |

### Clippy Configuration

Run `make lint` to check:
- All warnings are treated as errors (`-D warnings`)
- Specific lints allowed in `clippy.toml`
- No `panic!` in production code (use `panic_with_error!` instead)

### Documentation Standards

- **Public functions**: Must have doc comments with `///`
- **Complex logic**: Add inline comments explaining the "why"
- **Security-critical**: Document assumptions and invariants
- **Examples**: Include usage examples in doc comments

```rust
/// Distribute yield for a new epoch.
///
/// # Arguments
/// * `caller` - Address of the operator distributing yield
/// * `amount` - Amount of underlying asset to distribute as yield
///
/// # Events
/// Emits `YieldDistributed` with epoch number and amount
///
/// # Errors
/// - `ZeroAmount` if amount <= 0
/// - `NotOperator` if caller lacks YieldOperator role
/// - `InvalidVaultState` if vault not in Active state
pub fn distribute_yield(e: &Env, caller: Address, amount: i128) -> u32 {
    // Implementation...
}
```

## PR Standards

### Branch Naming

Use the format: `issue-<number>-<brief-description>`

```bash
# Good examples
git checkout -b issue-117-contributing-guide
git checkout -b issue-96-fix-rounding-errors
git checkout -b issue-45-add-emergency-multisig

# Bad examples
git checkout -b fix-stuff
git checkout -b feature-branch
git checkout -b hotfix
```

### Commit Messages

Follow **Conventional Commits** format:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Types**:
- `feat`: New feature or enhancement
- `fix`: Bug fix
- `test`: Adding or updating tests
- `docs`: Documentation changes
- `refactor`: Code refactoring without functional changes
- `perf`: Performance improvements
- `ci`: CI/CD related changes

**Examples**:
```bash
feat(vault): add emergency multi-sig withdrawal mechanism
fix(yield): correct epoch yield calculation for zero shares
test(kyc): add comprehensive zkme integration tests
docs(readme): update build instructions for new Rust version
```

### Pull Request Process

1. **Create PR from feature branch** against `main`
2. **Fill out PR template** completely
3. **Ensure CI passes** (automatic)
4. **Request reviews** from maintainers
5. **Address feedback** promptly
6. **Maintainers approve** (minimum 2 approvals required)
7. **Squash and merge** by maintainer

### Required Reviewers

- **Minimum 2 approvals** from core maintainers
- **At least 1 code review** from contract expert
- **1 security review** for changes to access control or fund flows

### PR Checklist

Before submitting a PR, ensure:

- [ ] **Code follows style guidelines** (`make fmt` and `make lint` pass)
- [ ] **All tests pass** (`make test` passes)
- [ ] **New functionality has tests** (minimum 80% coverage for new code)
- [ ] **No new `panic!`** statements (use `panic_with_error!`)
- [ ] **Events emitted** for all state changes
- [ ] **Documentation updated** (if applicable)
- [ ] **Breaking changes documented** (if applicable)

## Testing Guide

### Test Structure

Use the provided test harness in `test_helpers.rs`:

```rust
use crate::test_helpers::{setup, setup_with_kyc_bypass, mint_usdc, advance_time};

#[test]
fn test_vault_deposit() {
    // Setup test environment
    let ctx = setup_with_kyc_bypass();
    
    // Mint test tokens
    mint_usdc(&ctx.env, &ctx.asset_id, &ctx.user, 1_000_000);
    
    // Test deposit
    let shares = ctx.vault.deposit(&ctx.user, &1_000_000i128, &ctx.user);
    assert!(shares > 0);
}
```

### Test Naming Conventions

- **Test files**: `test_<module_name>.rs`
- **Test functions**: `test_<functionality>_scenario`
- **Integration tests**: `test_<contract>_<feature>`

```rust
// Good examples
fn test_deposit_with_kyc_verification()
fn test_yield_distribution_multiple_epochs()
fn test_emergency_withdraw_multi_sig_approval()

// Bad examples
fn test1()
fn deposit_test()
fn check_stuff()
```

### Test Categories

1. **Unit Tests**: Individual function testing
2. **Integration Tests**: Contract interaction testing
3. **Property Tests**: Edge cases and invariant testing
4. **Security Tests**: Attack vectors and access control

### Minimum Coverage Expectations

- **New features**: 90%+ line coverage
- **Bug fixes**: 100% coverage for the fixed code path
- **Critical paths** (funds, access control): 100% coverage
- **Overall repository**: Maintain 85%+ coverage

### Test Data Management

```rust
// Use deterministic test data
const TEST_USER: &str = "GDQD3O2P7F6X2J7X5K4L3Z2Q1W8E6R5T4Y3U2I1O";
const TEST_AMOUNT: i128 = 1_000_000;

// Clean up test state
#[test]
fn test_with_cleanup() {
    let ctx = setup();
    // Test logic...
    // Dropping ctx automatically cleans up
}
```

## Issue Workflow

### Claiming an Issue

1. **Check the issue** isn't already assigned
2. **Comment "I'd like to work on this"** to claim it
3. **Maintainer will assign** the issue to you
4. **Create branch** following naming convention
5. **Start implementation**

### Expected Timeline

- **Simple fixes**: 1-3 days
- **Feature implementation**: 1-2 weeks
- **Complex features**: 2-4 weeks
- **Security issues**: Immediate priority

### Communication Channels

- **GitHub Issues**: Primary communication for specific issues
- **GitHub Discussions**: General questions and architecture discussions
- **Discord**: Real-time collaboration (link in README)

### Issue Labels

- **`good first issue`**: Suitable for new contributors
- **`help wanted`**: Community contributions welcome
- **`bug`**: Bug reports and fixes
- **`enhancement`**: New features
- **`security`**: Security-related issues
- **`documentation`**: Docs and guides

### Issue Templates

Use the provided templates when creating new issues:
- **Bug reports**: Use bug report template
- **Feature requests**: Use feature request template
- **Security issues**: DO NOT use public templates (see Security Policy)

## Security Policy

### Reporting Vulnerabilities

**DO NOT** open public issues for security vulnerabilities!

#### Responsible Disclosure

1. **Email**: security@stellaryield.io
2. **Include**: Detailed description, steps to reproduce, potential impact
3. **Timeline**: We'll respond within 48 hours, provide fix timeline within 7 days
4. **Reward**: Bug bounty program available for valid vulnerabilities

#### Security Review Process

1. **Triage**: Security team assesses impact and scope
2. **Analysis**: Root cause analysis and exploit scenarios
3. **Fix**: Develop and test patches in private
4. **Disclosure**: Coordinated disclosure with maintainers
5. **Publication**: Security advisory and credit to researcher

### Security Guidelines for Contributors

- **Never commit** sensitive data (keys, passwords)
- **Use `panic_with_error!`** instead of `panic!` in contracts
- **Follow CEI pattern**: Checks → Effects → Interactions
- **Validate all inputs** with proper error handling
- **Test attack vectors**: Reentrancy, overflow, access control
- **Document security assumptions** in code comments

### Security Best Practices

```rust
// ✅ Good: Proper input validation
if amount <= 0 {
    panic_with_error!(e, Error::ZeroAmount);
}

// ✅ Good: Reentrancy protection
acquire_lock(e);
// State changes here
release_lock(e);

// ✅ Good: Access control check
require_role(e, &caller, Role::YieldOperator);

// ❌ Bad: Unchecked panic
panic!("This should never happen");
```

---

## Getting Help

- **New contributor questions**: Use GitHub Discussions
- **Issue-specific questions**: Comment on the issue
- **Security concerns**: Email security@stellaryield.io
- **General chat**: Join our Discord community

Thank you for contributing to StellarYield 🚀
