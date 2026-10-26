/**
 * Recursively converts bigint values to decimal strings for JSON serialization (#1181).
 *
 * JSON.stringify throws on bigint, and large numbers lose precision as JS numbers.
 * This replacer converts all bigint values to their decimal string representation,
 * while leaving other numeric types (counts, percentages) unchanged.
 *
 * @param _key - Object key being serialized (unused, required by JSON replacer signature)
 * @param value - Value being serialized
 * @returns Serialized value (bigint converted to string, others unchanged)
 */
export function serializeAmounts(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}
