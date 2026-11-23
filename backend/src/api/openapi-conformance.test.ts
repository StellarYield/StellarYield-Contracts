import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Response conformance tests against the OpenAPI spec (#1290).
 *
 * Documentation and implementation drift apart when nothing compares them.
 * This suite drives each documented `GET` route with seeded data and validates
 * the serialized response against the schema in `api/openapi.json` (the spec
 * `openapi-typescript` generates the shared client types from). Because the
 * validator treats `properties` as closed, a response that carries a field the
 * spec does not document fails the test — the drift the suite is here to catch.
 *
 * Routes that cannot be exercised here are listed in `EXCLUDED` with a reason;
 * a separate assertion guarantees every documented route is either covered or
 * explicitly excluded.
 */

const h = vi.hoisted(() => ({
  listVaults: vi.fn(),
  getVault: vi.fn(),
  query: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("../services/vault.js", () => ({
  VaultService: class {
    listVaults = h.listVaults;
    getVault = h.getVault;
  },
  validateFilterTree: () => null,
  VAULT_FIELD_ALLOWLIST: [],
  pickVaultFields: (value: unknown) => value,
}));

vi.mock("../db/index.js", () => ({ query: h.query }));
vi.mock("../cache/redis.js", () => ({ cacheGet: h.cacheGet, cacheSet: h.cacheSet }));
vi.mock("../services/stellar.js", () => ({
  readTotalAssets: vi.fn(),
  readVaultState: vi.fn(),
  readPaused: vi.fn(),
  readCooperator: vi.fn(),
  readCooperatorFeeBps: vi.fn(),
}));

interface JsonSchema {
  $ref?: string;
  type?: string | string[];
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
}

type Spec = {
  paths: Record<string, Record<string, { responses: Record<string, any> }>>;
  components: { schemas: Record<string, JsonSchema> };
};

const spec = JSON.parse(
  readFileSync(new URL("../../api/openapi.json", import.meta.url), "utf8"),
) as unknown as Spec;

function resolveRef(ref: string): JsonSchema {
  return ref
    .replace(/^#\//, "")
    .split("/")
    .reduce((acc: any, key) => acc[key], spec as any) as JsonSchema;
}

/** Validate `value` against `schema`, collecting dotted paths for failures. */
function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (schema.$ref) {
    validate(value, resolveRef(schema.$ref), path, errors);
    return;
  }

  if (value === null) {
    if (schema.nullable !== true && schema.type !== "null") {
      errors.push(`${path}: null is not allowed`);
    }
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      const properties = schema.properties ?? {};
      for (const required of schema.required ?? []) {
        if (!(required in (value as Record<string, unknown>))) {
          errors.push(`${path}: missing required field "${required}"`);
        }
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key in properties) {
          validate(child, properties[key], `${path}.${key}`, errors);
        } else if (schema.additionalProperties === true) {
          continue;
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          validate(child, schema.additionalProperties, `${path}.${key}`, errors);
        } else {
          errors.push(`${path}.${key}: undocumented field`);
        }
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      value.forEach((item, i) => validate(item, schema.items ?? {}, `${path}[${i}]`, errors));
      return;
    }
    case "integer":
      if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
      return;
    case "number":
      if (typeof value !== "number") errors.push(`${path}: expected number`);
      return;
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return;
    default:
      return;
  }
}

function conformanceErrors(operationPath: string, body: unknown) {
  const schema = spec.paths[operationPath]?.["get"]?.responses?.["200"]?.content?.["application/json"]?.schema;
  const errors: string[] = [];
  validate(body, schema ?? {}, operationPath, errors);
  return errors;
}

const VALID_CONTRACT_ID = `C${"A".repeat(55)}`;

const VAULT = {
  id: 1,
  contractId: VALID_CONTRACT_ID,
  factoryId: null,
  asset: `C${"B".repeat(55)}`,
  name: "Treasury Bill Vault",
  symbol: "sTBill",
  state: "Active",
  totalAssets: "1000000000000",
  totalSupply: "950000000000",
  totalSharesEverMinted: "960000000000",
  totalSharesEverBurned: "10000000000",
  depositorCount: 42,
  fundingTarget: null,
  fundingDeadline: null,
  fundingProgress: 20.5,
  minDeposit: null,
  maxDepositPerUser: null,
  zkmeVerifier: null,
  rwaName: "US Treasury Bill",
  rwaSymbol: "USTB",
  rwaDocumentUri: "https://example.com/docs/tbill.pdf",
  rwaCategory: "Government Debt",
  description: "Tokenized short-term US Treasury bills",
  logoUri: "https://example.com/logo.png",
  createdAt: new Date("2026-01-15T00:00:00.000Z"),
  updatedAt: new Date("2026-09-20T00:00:00.000Z"),
  lastIndexedLedger: 12345678,
  lastIndexedAt: new Date("2026-09-20T00:00:00.000Z"),
  decimalsMismatch: false,
};

function makeRes() {
  const res = {
    body: undefined as unknown,
    status: vi.fn().mockReturnThis(),
    json: vi.fn(function (this: any, body: unknown) {
      res.body = body;
      return res;
    }),
    set: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  return res;
}

function makeReq(overrides: any = {}) {
  return { params: {}, query: {}, headers: {}, body: {}, ...overrides } as any;
}

const next = vi.fn();

/** Seed the public routes' data; each probe returns the JSON body to validate. */
const PROBES: Record<string, () => Promise<unknown>> = {
  "/api/v1/vaults": async () => {
    const { listVaults } = await import("./controllers/vaults.js");
    h.listVaults.mockResolvedValue({ data: [VAULT], total: 1, page: 1, pageSize: 20 });
    const res = makeRes();
    await listVaults(makeReq(), res, next);
    return res.body;
  },
  "/api/v1/vaults/{contractId}": async () => {
    const { getVault } = await import("./controllers/vaults.js");
    h.getVault.mockResolvedValue(VAULT);
    const res = makeRes();
    await getVault(makeReq({ params: { contractId: VALID_CONTRACT_ID } }), res, next);
    return res.body;
  },
  "/api/v1/vaults/{contractId}/tvl-history": async () => {
    const { getVaultTvlHistory } = await import("./controllers/vaults.js");
    h.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM vaults WHERE contract_id")) {
        return Promise.resolve([{ id: 1 }]);
      }
      return Promise.resolve([
        {
          bucket: new Date("2026-09-20T00:00:00.000Z"),
          avg_total_assets: "1000000000000",
          max_total_assets: "1100000000000",
          min_total_assets: "900000000000",
        },
      ]);
    });
    const res = makeRes();
    await getVaultTvlHistory(
      makeReq({ params: { contractId: VALID_CONTRACT_ID }, query: { bucket: "day" } }),
      res,
      next,
    );
    return res.body;
  },
  "/api/v1/analytics/summary": async () => {
    const { getAnalyticsSummary } = await import("./controllers/analytics.js");
    h.cacheGet.mockResolvedValue(undefined);
    h.query.mockImplementation((sql: string) => {
      if (sql.includes("FROM users")) return Promise.resolve([{ count: "340" }]);
      if (sql.includes("FROM epochs")) return Promise.resolve([{ total: "1200000000000" }]);
      if (sql.includes("user_vault_positions")) return Promise.resolve([{ count: "300" }]);
      if (sql.includes("SUM(total_assets")) return Promise.resolve([{ total: "25000000000000" }]);
      if (sql.includes("FROM vaults")) return Promise.resolve([{ count: "12" }]);
      return Promise.resolve([]);
    });
    const res = makeRes();
    await getAnalyticsSummary(makeReq(), res, next);
    return res.body;
  },
  "/api/v1/analytics/tvl": async () => {
    const { getTvlAggregate } = await import("./controllers/analytics.js");
    h.query.mockResolvedValue([
      { total_value_locked: "25000000000000", active_vault_count: "7", funding_vault_count: "3" },
    ]);
    const res = makeRes();
    await getTvlAggregate(makeReq(), res, next);
    return res.body;
  },
  "/api/v1/analytics/vaults/group-by": async () => {
    const { getVaultsGroupBy } = await import("./controllers/analytics.js");
    h.query.mockResolvedValue([
      {
        grp: "Active",
        vault_count: "7",
        total_value_locked: "25000000000000",
        average_apy: "5.25",
      },
    ]);
    const res = makeRes();
    await getVaultsGroupBy(makeReq({ query: { by: "state" } }), res, next);
    return res.body;
  },
};

/**
 * Documented GET routes intentionally not probed here, with the reason.
 * `/health` and `/api/v1/health` return an operational payload (db pool,
 * memory, RPC probe, SSE count) that is deliberately outside the client-facing
 * contract documented for `openapi-typescript`; it is covered by
 * `src/api/routes/health.test.ts`.
 */
const EXCLUDED: Record<string, string> = {
  "/health": "operational health payload, not part of the client contract",
  "/api/v1/health": "operational health payload, not part of the client contract",
};

function documentedGetPaths(): string[] {
  return Object.entries(spec.paths)
    .filter(([, operations]) => operations["get"] !== undefined)
    .map(([path]) => path);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("OpenAPI response conformance (#1290)", () => {
  it("covers every documented GET route, or lists it as excluded", () => {
    const documented = documentedGetPaths();
    for (const path of documented) {
      const covered = path in PROBES;
      const excluded = path in EXCLUDED;
      expect(
        covered || excluded,
        `documented route ${path} is neither covered nor excluded`,
      ).toBe(true);
      expect(covered && excluded, `route ${path} is both covered and excluded`).toBe(false);
    }
  });

  for (const path of Object.keys(PROBES)) {
    it(`matches the spec: GET ${path}`, async () => {
      const raw = await PROBES[path]();
      // Emulate the wire format: dates and other non-JSON values are serialized
      // exactly as `res.json` would send them.
      const body = JSON.parse(JSON.stringify(raw));
      expect(next).not.toHaveBeenCalled();
      expect(body).toBeDefined();
      expect(conformanceErrors(path, body)).toEqual([]);
    });
  }

  it("fails when a response carries an undocumented field", () => {
    const body = {
      data: [{ ...VAULT, undocumented: true }],
      total: 1,
      page: 1,
      pageSize: 20,
    };
    const errors = conformanceErrors("/api/v1/vaults", body);
    expect(errors.some((e) => e.includes("undocumented field"))).toBe(true);
  });

  it("fails when a required field is missing", () => {
    const { depositorCount, ...withoutDepositorCount } = VAULT;
    void depositorCount;
    const errors = conformanceErrors("/api/v1/vaults/{contractId}", withoutDepositorCount);
    expect(errors.some((e) => e.includes("missing required field"))).toBe(true);
  });

  it("fails when a field has the wrong type", () => {
    const errors = conformanceErrors("/api/v1/vaults/{contractId}", {
      ...VAULT,
      id: "not-a-number",
    });
    expect(errors.some((e) => e.includes("expected integer"))).toBe(true);
  });
});
