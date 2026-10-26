# API Conventions

This document describes the conventions and standards used in the StellarYield API.

## Numeric Serialization

All token amounts and financial values are serialized as decimal strings in JSON responses (#1181).

### Rationale

- JavaScript `JSON.stringify` throws on `bigint` values
- Large numbers lose precision when represented as JavaScript `number` (IEEE 754 double)
- Decimal strings preserve exact precision for financial calculations

### Implementation

The Express `json replacer` is configured globally in `src/app.ts` to recursively convert all `bigint` values to their decimal string representation via `serializeAmounts()`.

### Examples

```json
{
  "totalSupply": "1000000000000000000000000000000",
  "userBalance": "500000000000000000000000000000",
  "yieldAmount": "123456789012345678901234567890"
}
```

### Non-Amount Numbers

Non-amount numeric values (counts, percentages, indices) are serialized as regular JavaScript numbers:

```json
{
  "epoch": 42,
  "totalHolders": 156,
  "participationRate": 0.87
}
```
