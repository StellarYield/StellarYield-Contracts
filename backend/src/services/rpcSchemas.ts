/**
 * Zod schemas for RPC response validation.
 *
 * Validates all RPC response shapes before any property access to close the
 * undefined property error attack surface. Throws RpcSchemaError on validation
 * failure with the offending path and Zod issues.
 *
 * Closes #1198
 */

import { z, type ZodIssue } from "zod";

/**
 * Typed error thrown when an RPC response fails Zod schema validation.
 *
 * @property {string} method - The RPC method name (e.g., "getEvents", "getLatestLedger")
 * @property {string} path - The offending Zod path (e.g., "latestLedger", "events.0.topic")
 * @property {ZodIssue[]} issues - The Zod validation issues array
 */
export class RpcSchemaError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly issues: ZodIssue[],
  ) {
    super(
      `RPC response schema validation failed for ${method} at path "${path}": ${
        issues[0]?.message ?? "unknown error"
      }`,
    );
    this.name = "RpcSchemaError";
  }
}

/**
 * Zod schema for getEvents response.
 *
 * Response includes an array of events and the latestLedger sequence number.
 * Each event contains type, contractId, id, topics, value, ledger, and other metadata.
 */
export const getEventsSchema = z
  .object({
    events: z.array(
      z
        .object({
          type: z.string(),
          contractId: z.string(),
          id: z.string(),
          ledger: z.number(),
          ledgerClosedAt: z.string(),
          txHash: z.string().optional(),
          topic: z.array(z.any()),
          value: z.any(),
          pagingToken: z.string().optional(),
          inSuccessfulContractCall: z.boolean().optional(),
          transactionIndex: z.number().optional(),
          operationIndex: z.number().optional(),
        })
        .passthrough(),
    ),
    latestLedger: z.number(),
  })
  .passthrough();

/**
 * Zod schema for getLatestLedger response.
 *
 * Response includes the latest ledger sequence, id, protocol version, and close time.
 */
export const getLatestLedgerSchema = z
  .object({
    sequence: z.number(),
    id: z.string(),
    protocolVersion: z.number(),
    latestLedgerCloseTime: z.number().optional(),
  })
  .passthrough();

/**
 * Zod schema for getNetwork response.
 *
 * Response includes the network passphrase, friendbot URL, and protocol version.
 */
export const getNetworkSchema = z
  .object({
    passphrase: z.string(),
    friendbotUrl: z.string().optional(),
    protocolVersion: z.number().optional(),
  })
  .passthrough();

/**
 * Zod schema for getLedgerEntries response.
 *
 * Response includes an array of ledger entries and the latestLedger sequence number.
 */
export const getLedgerEntriesSchema = z
  .object({
    entries: z.array(
      z
        .object({
          key: z.string(),
          xdr: z.string(),
          lastModifiedLedgerSeq: z.number().optional(),
        })
        .passthrough(),
    ),
    latestLedger: z.number(),
  })
  .passthrough();

/**
 * Zod schema for simulateTransaction response.
 *
 * Response shape varies between success and error. This schema accepts both variants.
 * Success responses include result with retval and auth, transaction data, and events.
 * Error responses include error field.
 */
export const simulateTransactionSchema = z
  .object({
    // Success variant fields
    result: z
      .object({
        retval: z.any().optional(),
        auth: z.array(z.any()).optional(),
      })
      .passthrough()
      .optional(),
    transactionData: z.string().optional(),
    events: z.array(z.any()).optional(),
    cost: z
      .object({
        cpuInsns: z.string(),
        memBytes: z.string(),
      })
      .passthrough()
      .optional(),
    restorePreamble: z
      .object({
        transactionData: z.string(),
        minResourceFee: z.string(),
      })
      .passthrough()
      .optional(),
    // Error variant field
    error: z.string().optional(),
    // Common fields
    latestLedger: z.number().optional(),
    minResourceFee: z.string().optional(),
  })
  .passthrough();

/**
 * Helper to validate an RPC response against a Zod schema and throw RpcSchemaError on failure.
 *
 * @param {string} method - The RPC method name
 * @param {any} response - The raw RPC response to validate
 * @param {z.ZodSchema} schema - The Zod schema to validate against
 * @returns {any} The validated response (typed by the schema)
 * @throws {RpcSchemaError} If validation fails
 */
export function validateRpcResponse<T>(
  method: string,
  response: unknown,
  schema: z.ZodSchema<T>,
): T {
  const result = schema.safeParse(response);
  if (!result.success) {
    const path = result.error.issues[0]?.path.join(".") ?? "";
    throw new RpcSchemaError(method, path, result.error.issues);
  }
  return result.data;
}
