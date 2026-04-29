# Review Checklist

Before merging any PR, ensure the following points are addressed:

## 1. Automated Checks
- [ ] `cargo fmt` has been run and follows project style.
- [ ] `cargo clippy` runs without warnings (all warnings are treated as errors).
- [ ] `make test` or `cargo test` passes for all affected contracts.
- [ ] New functionality has associated tests with high coverage.

## 2. Storage & Gas
- [ ] Storage keys are unique and follow the project's naming convention.
- [ ] Persistent storage is used correctly for long-term data (balances, registry).
- [ ] Instance storage is used for global configuration and hot state.
- [ ] TTL bumps are implemented for all persistent and instance data.
- [ ] No unbounded loops or Vec loads that could lead to gas exhaustion.

## 3. Security & Logic
- [ ] Checks-Effects-Interactions (CEI) pattern is followed.
- [ ] Reentrancy locks are used where external contract calls are made.
- [ ] Access control (RBAC) is enforced for all privileged functions.
- [ ] KYC checks are integrated for user-facing operations (deposit, transfer).
- [ ] No use of `panic!` — use `panic_with_error!` for graceful failure.
- [ ] Events are emitted for all significant state changes.

## 4. Documentation
- [ ] Doc comments (`///`) are present for all public functions.
- [ ] README or other documentation is updated if behavior changes.
- [ ] Breaking changes are explicitly called out in the PR description.

## 5. CI/CD
- [ ] No CI workflow changes without a strong justification.
- [ ] Versioning (Contract and Storage Schema) is updated if necessary.
