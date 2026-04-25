# Release Notes Template

Use this template for documenting contract updates. This supports safer upgrades and clearer communication to integrators.

## Version X.Y.Z

**Release Date:** YYYY-MM-DD

---

## Overview

Brief summary of the release, highlighting key achievements and goals.

---

## Breaking Changes

> ⚠️ **Important**: Document all breaking changes clearly. Integrators must update their implementations.

- **Change 1**: Description of what changed and why
  - `old_function_name()` → **removed** or **renamed** to `new_function_name()`
  - Migration path: How integrators should update
  
- **Change 2**: Description
  - Parameter changes, return type changes, behavioral changes
  - Migration path example:
    ```rust
    // Before
    let shares = vault.deposit(amount);
    
    // After
    let shares = vault.deposit(amount, receiver);
    ```

---

## Migration Notes

Step-by-step instructions for integrators to migrate to this version.

### Prerequisites
- Required dependency versions
- Required contract version upgrades
- Sequence of steps if upgrading from a specific prior version

### Migration Steps

1. **Step 1**: Description
   ```rust
   // Code example
   ```

2. **Step 2**: Description
   ```rust
   // Code example
   ```

3. **Step 3**: Verification
   - How to verify the migration was successful
   - Expected state after migration

### Rollback Plan
Instructions for reverting to the previous version if needed.

---

## New Features

- **Feature 1**: `new_function_name()`
  - Description of functionality
  - Use case and benefits
  - Example usage:
    ```rust
    let result = vault.new_function_name(param1, param2);
    ```

- **Feature 2**: Enhanced state tracking
  - Improved monitoring capabilities
  - Available through new view function

---

## Event Changes

Document all new, modified, or removed events.

### New Events

- **`EventName`**
  ```rust
  pub struct EventName {
      pub field1: Type1,
      pub field2: Type2,
  }
  ```
  - When emitted: Description of conditions triggering this event
  - Used by: Integrators or systems listening to this event
  - Example:
    ```
    EventName { field1: value1, field2: value2 }
    ```

### Modified Events

- **`ExistingEvent`**
  - Old structure: Fields that changed
  - New structure: Updated fields and their meanings
  - Migration note: How event consumers should adapt

### Removed Events

- **`DeprecatedEvent`**
  - Reason for removal
  - Replacement event (if any)
  - Action required: How to detect and handle missing events

---

## Storage Changes

Document any changes to contract storage schema, TTL adjustments, or data layout changes.

- **Storage Key Changes**: If storage keys were added, removed, or restructured
- **TTL Updates**: Any changes to INSTANCE or PERSISTENT lifetime thresholds
- **Migration Impact**: How existing data is handled

---

## Performance Improvements

- **Optimization 1**: Description and expected improvement
  - Benchmark results (before/after)
  - Impact on transaction costs

- **Optimization 2**: Description
  - Related to memory, computation, or storage

---

## Bug Fixes

- **Bug Fix 1**: Issue description
  - Root cause
  - Solution implemented
  - Related issues/PRs: #123

- **Bug Fix 2**: Issue description
  - Impact: Who was affected and how
  - Fix details

---

## Security Updates

> 🔒 Security fixes take priority.

- **CVE-XXXX-XXXXX** or **Security Fix 1**: Description
  - Vulnerability type: (e.g., Reentrancy, Overflow, Authorization)
  - Severity: Critical / High / Medium / Low
  - Affected versions: List versions impacted
  - Fix: How it was addressed
  - Mitigation: What users should do immediately

---

## Deprecations

List features or functions that will be removed in future versions.

- **Function Name**: Will be removed in version X.Y.Z
  - Replacement: Recommended alternative
  - Migration deadline: When support ends

---

## Documentation Updates

- Updated API documentation at [link]
- New integration guide: [link]
- Architecture decision record: [ADR-###]

---

## Testing & Validation

- **Test Coverage**: New code achieves X% coverage
- **Test Scenarios**: Key scenarios validated
  - Scenario 1: Description
  - Scenario 2: Description
  
- **Mainnet Staging**: Results from testnet deployment (if applicable)

---

## Known Issues & Limitations

- **Known Issue 1**: Description
  - Workaround: If applicable
  - Track in: Issue #XXX

- **Limitation 1**: Constraint or edge case
  - Reason: Why this limitation exists
  - Future: When it might be addressed

---

## Checksums & Artifacts

- **WASM Hash**: `0x...`
- **Build Date**: YYYY-MM-DD HH:MM:SS UTC
- **Compiler**: `rustc X.Y.Z`
- **Soroban SDK**: `soroban-sdk X.Y.Z`

---

## Contributors

- @contributor1
- @contributor2

---

## Links

- **PR**: #XXX
- **Related Issues**: #276, #287, #303
- **Commits**: [compare link]
- **Deployment Guide**: [link]
- **Support**: Discord / GitHub Discussions

---

## Upgrade Instructions

### For Contract Admins

1. Review all breaking changes and migration notes
2. Test thoroughly on testnet
3. Execute migration steps in order
4. Verify expected state changes
5. Monitor events post-upgrade

### For Integrators

1. Review breaking changes section
2. Update your integration code
3. Test in your staging environment
4. Deploy to production with confidence

### For Users

- No action required unless you integrate directly with this contract
- UI/applications using this contract will be updated automatically
