---
name: Bug Report
about: Create a report to help us improve
title: "[BUG] "
labels: bug
assignees: ""
---

## Bug Description

<!-- A clear and concise description of what the bug is. -->

## Expected Behavior

<!-- A clear and concise description of what you expected to happen. -->

## Actual Behavior

<!-- A clear and concise description of what actually happened. -->

## Steps to Reproduce

<!--
Provide steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error
-->

## Environment

### Contract Details

- Contract: `single_rwa_vault` / `vault_factory` / `SDK`
- Function/Method: <!-- If applicable -->
- Network: Testnet / Mainnet / Local

### Technical Details

- Rust version: <!-- Run `rustc --version` -->
- Stellar CLI version: <!-- Run `stellar --version` -->
- Node.js version: <!-- If SDK related, run `node --version` -->
- Operating System: <!-- e.g., macOS 14.0, Ubuntu 22.04 -->

### Configuration

- Branch/Commit: <!-- Git hash or branch name -->
- Build flags: <!-- Any special build configuration -->

## Error Messages / Logs

<!--
Paste any error messages, stack traces, or relevant logs here.
Use code blocks for formatting:
```
Error: contract error(5): InvalidVaultState
```
-->

## Transaction Details (if applicable)

- Transaction Hash: <!-- Stellar transaction hash -->
- Contract Address: <!-- Contract ID -->
- Function Called: <!-- Contract function that failed -->
- Input Parameters: <!-- Parameters passed to function -->

## Impact Assessment

### Severity

- [ ] Critical - Security vulnerability, fund loss, or contract unusable
- [ ] High - Major functionality broken, affecting many users
- [ ] Medium - Some functionality broken, affecting limited users
- [ ] Low - Minor issue, workaround available

### Affected Users

- [ ] All users
- [ ] Vault operators only
- [ ] Specific vault instances
- [ ] SDK users only
- [ ] Local development only

### Workarounds

<!-- Describe any available workarounds -->

## Additional Context

<!--
Add any other context about the problem here:
- When did this start happening?
- Has it worked before?
- Recent changes that might be related
- Similar issues you've seen
-->

## Security Concerns

<!--
If this bug has security implications, DO NOT file a public issue.
Instead, email: security@stellaryield.io
-->

- [ ] This issue has security implications (DO NOT submit publicly)

## Checklist

- [ ] I have searched existing issues for duplicates
- [ ] I have provided all requested information
- [ ] I have included relevant error messages and logs
- [ ] I have specified the environment details
- [ ] This is not a security vulnerability (or I've reported it privately)

---

**Thank you for helping improve StellarYield!** 🐛
