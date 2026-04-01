# Tracked issues & known risks

This file lists **known issues, accepted risks, and follow-ups** that security reviews and `SECURITY.md` reference by ID.

| ID | Title | Risk | Status | Mitigation / notes |
|----|--------|------|--------|---------------------|
| K1 | ERC-4626 rounding & dust | Medium | Open | Documented invariants; `preview_*` guards (#96); integrators must handle small-amount UX. |
| K2 | Trust in Stellar Asset Contract (SAC) | High (if asset malicious) | Accepted | Only standard SAC behavior assumed; malicious or buggy asset can break accounting. |
| K3 | zkMe verifier liveness & correctness | Medium | Accepted | KYC gating; verifier compromise or censorship affects deposit/transfer policy. |
| K4 | Operator / admin key compromise | Critical | Accepted | Role separation; operational procedures; multisig recommended for production. |
| K5 | Soroban host / SDK upgrades | Low–Medium | Monitoring | Pin toolchains; regression-test after network upgrades. |

---

## How to add an issue

1. Append a row with a new `K#` id (or use GitHub issue numbers once filed).
2. Update `SECURITY.md` → *Known Issues / Accepted Risks* if the risk is audit-relevant.
3. Link to PRs that fix or partially mitigate the issue.

---

**Reviewer sign-off (audit prep):** assign a contributor to confirm this table matches reality before external audit.
