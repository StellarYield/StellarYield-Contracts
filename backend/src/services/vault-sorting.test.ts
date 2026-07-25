import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("../cache/redis.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
}));

import { VaultService, parseVaultSort, MAX_VAULT_SORT_FIELDS } from "./vault.js";
import * as db from "../db/index.js";

/** The SQL string handed to the first `query` call — the vault page query. */
function listSql(): string {
  return vi.mocked(db.query).mock.calls[0][0] as string;
}

/** The ORDER BY clause of the vault page query, whitespace-collapsed. */
function orderByOf(sql: string): string {
  const match = /ORDER BY([\s\S]*?)LIMIT/.exec(sql);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

describe("parseVaultSort (#855)", () => {
  it("defaults to created_at using the order parameter", () => {
    expect(parseVaultSort(undefined, "desc")).toEqual({
      ok: true,
      specs: [{ field: "created_at", direction: "desc" }],
    });
    expect(parseVaultSort("", "asc")).toEqual({
      ok: true,
      specs: [{ field: "created_at", direction: "asc" }],
    });
  });

  it("parses a comma-separated list of field:direction pairs", () => {
    expect(parseVaultSort("state:asc,total_assets:desc", "desc")).toEqual({
      ok: true,
      specs: [
        { field: "state", direction: "asc" },
        { field: "total_assets", direction: "desc" },
      ],
    });
  });

  it("preserves the order the fields were listed in", () => {
    const result = parseVaultSort("total_assets:desc,state:asc", "desc");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.specs.map((s) => s.field)).toEqual(["total_assets", "state"]);
  });

  it("falls back to the order parameter for fields with no explicit direction", () => {
    // Legacy single-field form: ?sort=total_assets&order=asc
    expect(parseVaultSort("total_assets", "asc")).toEqual({
      ok: true,
      specs: [{ field: "total_assets", direction: "asc" }],
    });
    expect(parseVaultSort("state,total_assets:desc", "asc")).toEqual({
      ok: true,
      specs: [
        { field: "state", direction: "asc" },
        { field: "total_assets", direction: "desc" },
      ],
    });
  });

  it("tolerates whitespace around fields", () => {
    expect(parseVaultSort(" state:asc , total_assets:desc ", "desc")).toEqual({
      ok: true,
      specs: [
        { field: "state", direction: "asc" },
        { field: "total_assets", direction: "desc" },
      ],
    });
  });

  it("accepts exactly the maximum number of fields", () => {
    const result = parseVaultSort("state:asc,total_assets:desc,created_at:asc", "desc");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.specs).toHaveLength(MAX_VAULT_SORT_FIELDS);
  });

  it("rejects more than the maximum number of fields", () => {
    const result = parseVaultSort(
      "state:asc,total_assets:desc,created_at:asc,name:asc",
      "desc",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("at most 3 fields");
  });

  it("rejects fields outside the allowlist", () => {
    const result = parseVaultSort("state:asc,rwa_document_uri:desc", "desc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Unknown sort field");
    expect(result.message).toContain("rwa_document_uri");
  });

  it("rejects an invalid direction", () => {
    const result = parseVaultSort("state:sideways", "desc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Invalid sort direction");
  });

  it("rejects duplicate fields", () => {
    const result = parseVaultSort("state:asc,state:desc", "desc");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Duplicate sort field");
  });

  it("rejects empty segments", () => {
    expect(parseVaultSort("state:asc,,total_assets:desc", "desc").ok).toBe(false);
    expect(parseVaultSort("state:asc:desc", "desc").ok).toBe(false);
  });

  it("rejects SQL injection attempts through the sort field", () => {
    const result = parseVaultSort("created_at; DROP TABLE vaults--", "desc");
    expect(result.ok).toBe(false);
  });
});

describe("VaultService.listVaults multi-field sorting (#855)", () => {
  let service: VaultService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new VaultService();
    vi.mocked(db.query).mockResolvedValue([]);
  });

  it("emits one ORDER BY term per sort field, in order", async () => {
    await service.listVaults({
      page: 1,
      pageSize: 20,
      sort: "state:asc,total_assets:desc",
      order: "desc",
    });

    expect(orderByOf(listSql())).toBe("v.state ASC, v.total_assets DESC");
  });

  it("still honours the legacy single-field sort and order pair", async () => {
    await service.listVaults({
      page: 1,
      pageSize: 20,
      sort: "total_assets",
      order: "asc",
    });

    expect(orderByOf(listSql())).toBe("v.total_assets ASC");
  });

  it("defaults to created_at DESC when no sort is supplied", async () => {
    await service.listVaults({ page: 1, pageSize: 20 });

    expect(orderByOf(listSql())).toBe("v.created_at DESC");
  });

  it("appends the id tiebreaker in the primary sort direction when paging by cursor", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ id: 5, created_at: new Date("2025-01-01").toISOString() }),
    ).toString("base64url");

    await service.listVaults({
      page: 1,
      pageSize: 20,
      cursor,
      sort: "state:asc,total_assets:desc",
      order: "desc",
    });

    expect(orderByOf(listSql())).toBe("v.state ASC, v.total_assets DESC, v.id ASC");
  });

  it("throws rather than interpolating an unvalidated sort field into SQL", async () => {
    await expect(
      service.listVaults({
        page: 1,
        pageSize: 20,
        sort: "created_at; DROP TABLE vaults--",
        order: "desc",
      }),
    ).rejects.toThrow(/Invalid sort parameter/);

    expect(db.query).not.toHaveBeenCalled();
  });
});
