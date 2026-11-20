import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { query } = await import("../../db/index.js");
  const { idempotency } = await import("./idempotency.js");
  return { query: query as ReturnType<typeof vi.fn>, idempotency };
}

function makeReqRes(opts: {
  method?: string;
  originalUrl?: string;
  body?: unknown;
  idempotencyKey?: string;
}) {
  const req = {
    method: opts.method ?? "POST",
    originalUrl: opts.originalUrl ?? "/api/v1/admin/indexer/backfill",
    body: opts.body ?? {},
    headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {},
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
  } as any;
  const res = {
    statusCode: 200,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("idempotency middleware (#1186)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes through when no Idempotency-Key header is present", async () => {
    const { query, idempotency } = await getTestContext();
    const { req, res, next } = makeReqRes({});

    await idempotency()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });

  it("passes through for non-POST requests even with a key", async () => {
    const { query, idempotency } = await getTestContext();
    const { req, res, next } = makeReqRes({ method: "GET", idempotencyKey: "k1" });

    await idempotency()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });

  it("executes the handler and stores the response on first use", async () => {
    const { query, idempotency } = await getTestContext();
    query.mockResolvedValue([]);
    const { req, res, next } = makeReqRes({
      idempotencyKey: "k1",
      body: { fromLedger: 1 },
    });

    await idempotency()(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    res.json({ ok: true });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO idempotency_keys"),
      expect.arrayContaining(["k1", expect.stringContaining("POST"), expect.any(String), 200]),
    );
  });

  it("replays the stored response for an identical retry", async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(JSON.stringify({ a: 1 })).digest("hex");
    const { query, idempotency } = await getTestContext();

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE")) return [];
      return [
        {
          request_hash: hash,
          response_status: 201,
          response_body: { ok: true },
        },
      ];
    });

    const { req, res, next } = makeReqRes({ idempotencyKey: "k1", body: { a: 1 } });
    await idempotency()(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("returns 422 when the same key is reused with a different body", async () => {
    const { createHash } = await import("node:crypto");
    const otherHash = createHash("sha256").update(JSON.stringify({ a: 2 })).digest("hex");
    const { query, idempotency } = await getTestContext();

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE")) return [];
      return [
        {
          request_hash: otherHash,
          response_status: 200,
          response_body: { ok: true },
        },
      ];
    });

    const { req, res, next } = makeReqRes({ idempotencyKey: "k1", body: { a: 1 } });
    await idempotency()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("purges keys older than 24 hours", async () => {
    const { query, idempotency } = await getTestContext();
    query.mockResolvedValue([]);
    const { req, res, next } = makeReqRes({ idempotencyKey: "k1" });

    await idempotency()(req, res, next);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM idempotency_keys"));
  });
});
