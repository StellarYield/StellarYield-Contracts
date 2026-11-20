/**
 * Soroban event topic matcher with wildcard support.
 *
 * Provides utilities for matching event topic arrays against patterns with "*"
 * wildcard support. Used by the indexer to replace inline topic comparisons.
 *
 * Closes #1196
 */

import { xdr, scValToNative } from "@stellar/stellar-sdk";

/**
 * Extract topic strings from a Soroban event.
 *
 * Converts each topic ScVal to its string representation using scValToNative.
 * Returns an empty array if topics are missing or malformed.
 */
function extractTopics(event: any): string[] {
  try {
    const topics = event?.topic ?? event?.topics;
    if (!Array.isArray(topics)) return [];

    return topics.map((t) => {
      const scVal = typeof t === "string" ? xdr.ScVal.fromXDR(t, "base64") : (t as xdr.ScVal);
      return String(scValToNative(scVal) ?? "");
    });
  } catch {
    return [];
  }
}

/**
 * Returns true if the event's topic array matches the pattern array.
 *
 * Matching rules:
 * - "*" at any position matches any value at that position.
 * - Arrays of different lengths never match (length must be exact).
 * - All non-wildcard positions must match the corresponding event topic string.
 *
 * @param {any} event - The raw Soroban event (contains topic or topics field)
 * @param {string[]} pattern - The pattern array with optional "*" wildcards
 * @returns {boolean} True if the event topics match the pattern
 *
 * @example
 * matchTopic(event, ["vault", "deposit"]) // exact match
 * matchTopic(event, ["vault", "*"]) // wildcard second topic
 * matchTopic(event, ["*", "*"]) // match any two-topic event
 */
export function matchTopic(event: any, pattern: string[]): boolean {
  const topics = extractTopics(event);
  if (topics.length !== pattern.length) return false;
  return pattern.every((p, i) => p === "*" || p === topics[i]);
}
