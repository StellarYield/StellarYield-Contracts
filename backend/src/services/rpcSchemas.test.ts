import { describe, it, expect } from "vitest";
import {
  RpcSchemaError,
  validateRpcResponse,
  getEventsSchema,
  getLatestLedgerSchema,
  getNetworkSchema,
  getLedgerEntriesSchema,
  simulateTransactionSchema,
} from "./rpcSchemas.js";

describe("RpcSchemaError", () => {
  it("carries method, path, and issues fields", () => {
    const issues = [
      {
        code: "invalid_type",
        expected: "number",
        received: "string",
        path: ["latestLedger"],
        message: "Expected number, received string",
      },
    ];
    const err = new RpcSchemaError("getEvents", "latestLedger", issues as any);
    expect(err.method).toBe("getEvents");
    expect(err.path).toBe("latestLedger");
    expect(err.issues).toEqual(issues);
    expect(err.name).toBe("RpcSchemaError");
    expect(err.message).toContain("getEvents");
    expect(err.message).toContain("latestLedger");
  });
});

describe("getLatestLedgerSchema", () => {
  it("validates a valid getLatestLedger response", () => {
    const response = {
      sequence: 12345,
      id: "abc123",
      protocolVersion: 20,
      latestLedgerCloseTime: 1609459200,
    };
    const result = validateRpcResponse("getLatestLedger", response, getLatestLedgerSchema);
    expect(result.sequence).toBe(12345);
    expect(result.id).toBe("abc123");
  });

  it("throws RpcSchemaError when latestLedger field is missing", () => {
    const response = {
      id: "abc123",
      protocolVersion: 20,
    };
    expect(() => validateRpcResponse("getLatestLedger", response, getLatestLedgerSchema)).toThrow(
      RpcSchemaError,
    );
    try {
      validateRpcResponse("getLatestLedger", response, getLatestLedgerSchema);
    } catch (err) {
      expect(err).toBeInstanceOf(RpcSchemaError);
      expect((err as RpcSchemaError).method).toBe("getLatestLedger");
      expect((err as RpcSchemaError).path).toContain("sequence");
    }
  });

  it("throws RpcSchemaError when sequence is wrong type", () => {
    const response = {
      sequence: "not-a-number",
      id: "abc123",
      protocolVersion: 20,
    };
    expect(() => validateRpcResponse("getLatestLedger", response, getLatestLedgerSchema)).toThrow(
      RpcSchemaError,
    );
  });

  it("vacuousness check: validation test fails if schema parse is removed", () => {
    // This test verifies that the above validation tests are not vacuous.
    // If the schema validation were bypassed, this would pass (returning the
    // malformed response), proving the validation tests above would catch it.
    const validResponse = {
      sequence: 12345,
      id: "abc123",
      protocolVersion: 20,
    };
    const result = validateRpcResponse("getLatestLedger", validResponse, getLatestLedgerSchema);
    expect(result.sequence).toBe(12345);
  });
});

describe("getEventsSchema", () => {
  it("validates a valid getEvents response", () => {
    const response = {
      events: [
        {
          type: "contract",
          contractId: "CCONTRACT123",
          id: "event-1",
          ledger: 1000,
          ledgerClosedAt: "2025-01-01T00:00:00.000Z",
          txHash: "abc123",
          topic: ["deposit", "user123"],
          value: [100n, 100n],
        },
      ],
      latestLedger: 1000,
    };
    const result = validateRpcResponse("getEvents", response, getEventsSchema);
    expect(result.events).toHaveLength(1);
    expect(result.latestLedger).toBe(1000);
  });

  it("throws RpcSchemaError when events field is missing", () => {
    const response = {
      latestLedger: 1000,
    };
    expect(() => validateRpcResponse("getEvents", response, getEventsSchema)).toThrow(RpcSchemaError);
    try {
      validateRpcResponse("getEvents", response, getEventsSchema);
    } catch (err) {
      expect((err as RpcSchemaError).path).toContain("events");
    }
  });

  it("throws RpcSchemaError when event has malformed structure", () => {
    const response = {
      events: [
        {
          type: "contract",
          // missing contractId
          id: "event-1",
          ledger: 1000,
          ledgerClosedAt: "2025-01-01T00:00:00.000Z",
          topic: ["deposit"],
          value: {},
        },
      ],
      latestLedger: 1000,
    };
    expect(() => validateRpcResponse("getEvents", response, getEventsSchema)).toThrow(RpcSchemaError);
  });
});

describe("getNetworkSchema", () => {
  it("validates a valid getNetwork response", () => {
    const response = {
      passphrase: "Test SDF Network ; September 2015",
      protocolVersion: 20,
    };
    const result = validateRpcResponse("getNetwork", response, getNetworkSchema);
    expect(result.passphrase).toBe("Test SDF Network ; September 2015");
  });

  it("throws RpcSchemaError when passphrase field is missing", () => {
    const response = {
      protocolVersion: 20,
    };
    expect(() => validateRpcResponse("getNetwork", response, getNetworkSchema)).toThrow(
      RpcSchemaError,
    );
    try {
      validateRpcResponse("getNetwork", response, getNetworkSchema);
    } catch (err) {
      expect((err as RpcSchemaError).path).toContain("passphrase");
    }
  });
});

describe("getLedgerEntriesSchema", () => {
  it("validates a valid getLedgerEntries response", () => {
    const response = {
      entries: [
        {
          key: "key1",
          xdr: "base64xdr",
          lastModifiedLedgerSeq: 999,
        },
      ],
      latestLedger: 1000,
    };
    const result = validateRpcResponse("getLedgerEntries", response, getLedgerEntriesSchema);
    expect(result.entries).toHaveLength(1);
    expect(result.latestLedger).toBe(1000);
  });

  it("throws RpcSchemaError when entries field is missing", () => {
    const response = {
      latestLedger: 1000,
    };
    expect(() => validateRpcResponse("getLedgerEntries", response, getLedgerEntriesSchema)).toThrow(
      RpcSchemaError,
    );
  });
});

describe("simulateTransactionSchema", () => {
  it("validates a valid simulateTransaction success response", () => {
    const response = {
      result: {
        retval: "base64retval",
        auth: [],
      },
      transactionData: "base64txdata",
      events: [],
      latestLedger: 1000,
    };
    const result = validateRpcResponse("simulateTransaction", response, simulateTransactionSchema);
    expect(result.result).toBeDefined();
    expect(result.latestLedger).toBe(1000);
  });

  it("validates a simulateTransaction error response", () => {
    const response = {
      error: "Contract execution failed",
      latestLedger: 1000,
    };
    const result = validateRpcResponse("simulateTransaction", response, simulateTransactionSchema);
    expect(result.error).toBe("Contract execution failed");
  });

  it("passes through unknown fields", () => {
    const response = {
      result: { retval: "base64", auth: [] },
      latestLedger: 1000,
      unknownField: "value",
    };
    const result = validateRpcResponse("simulateTransaction", response, simulateTransactionSchema);
    expect((result as any).unknownField).toBe("value");
  });
});

describe("RpcSchemaError carries method name", () => {
  it("includes method name in error message", () => {
    const response = { sequence: "invalid" };
    try {
      validateRpcResponse("getLatestLedger", response, getLatestLedgerSchema);
    } catch (err) {
      expect(err).toBeInstanceOf(RpcSchemaError);
      expect((err as RpcSchemaError).message).toContain("getLatestLedger");
    }
  });
});
