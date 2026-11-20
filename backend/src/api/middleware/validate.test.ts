import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../config.js", () => ({
  config: { strictQueryParams: false },
}));

vi.mock("../../utils/address.js", () => ({
  classifyAddress: (addr: string) => {
    if (/^M[A-Z0-9]+$/.test(addr)) return "muxed";
    if (/^G[A-Z2-7]{55}$/.test(addr)) return "account";
    return "invalid";
  },
}));

import { config } from "../../config.js";

async function getTestContext() {
  const { validateQuery, validateParams, validateBody, stellarAddressSchema } = await import(
    "./validate.js"
  );
  return { validateQuery, validateParams, validateBody, stellarAddressSchema };
}

function makeReqRes(opts: {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
} = {}) {
  const req = {
    params: opts.params ?? {},
    query: opts.query ?? {},
    body: opts.body ?? {},
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe("stellarAddressSchema (#1188)", () => {
  it("accepts a valid G-address", async () => {
    const { stellarAddressSchema } = await getTestContext();
    const g = "G" + "A".repeat(55);
    expect(stellarAddressSchema.safeParse(g).success).toBe(true);
  });

  it("rejects a muxed M-address", async () => {
    const { stellarAddressSchema } = await getTestContext();
    const result = stellarAddressSchema.safeParse("M" + "A".repeat(68));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Muxed addresses are not supported");
    }
  });

  it("rejects a malformed address", async () => {
    const { stellarAddressSchema } = await getTestContext();
    expect(stellarAddressSchema.safeParse("not-an-address").success).toBe(false);
  });
});

describe("validateParams (#1188)", () => {
  it("returns 422 with code MUXED_ADDRESS_NOT_SUPPORTED for an M-address", async () => {
    const { validateParams, stellarAddressSchema } = await getTestContext();
    const { req, res, next } = makeReqRes({
      params: { address: "M" + "A".repeat(68) },
    });

    validateParams({ address: stellarAddressSchema } as any)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MUXED_ADDRESS_NOT_SUPPORTED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a valid G-address through unchanged", async () => {
    const { validateParams, stellarAddressSchema } = await getTestContext();
    const address = "G" + "B".repeat(55);
    const { req, res, next } = makeReqRes({ params: { address } });

    validateParams({ address: stellarAddressSchema } as any)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.params.address).toBe(address);
  });

  it("still rejects a malformed address with 400", async () => {
    const { validateParams, stellarAddressSchema } = await getTestContext();
    const { req, res, next } = makeReqRes({ params: { address: "not-an-address" } });

    validateParams({ address: stellarAddressSchema } as any)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("validateBody (#1188)", () => {
  it("returns 422 for a muxed address nested in a body array", async () => {
    const { validateBody, stellarAddressSchema } = await getTestContext();
    const schema = (await import("zod")).z.object({
      addresses: (await import("zod")).z.array(stellarAddressSchema),
    });
    const { req, res, next } = makeReqRes({
      body: { addresses: ["G" + "A".repeat(55), "M" + "A".repeat(68)] },
    });

    validateBody(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MUXED_ADDRESS_NOT_SUPPORTED" }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe("validateQuery strict mode (#1185)", () => {
  afterEach(() => {
    (config as { strictQueryParams: boolean }).strictQueryParams = false;
  });

  const schema = {
    _def: { typeName: "ZodObject", shape: () => ({ limit: true }) },
    shape: { limit: true },
    safeParse: vi.fn((v: unknown) => ({ success: true, data: v })),
  } as any;

  it("rejects unknown query keys with 422 listing them when strict mode is on", async () => {
    (config as { strictQueryParams: boolean }).strictQueryParams = true;
    const { validateQuery } = await getTestContext();
    const { req, res, next } = makeReqRes({ query: { limit: "10", limt: "10" } });

    validateQuery(schema)(req, res, next);

    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ unknownParams: ["limt"] }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("ignores unknown query keys when strict mode is off", async () => {
    (config as { strictQueryParams: boolean }).strictQueryParams = false;
    const { validateQuery } = await getTestContext();
    const { req, res, next } = makeReqRes({ query: { limit: "10", limt: "10" } });

    validateQuery(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("passes a query with only known keys when strict mode is on", async () => {
    (config as { strictQueryParams: boolean }).strictQueryParams = true;
    const { validateQuery } = await getTestContext();
    const { req, res, next } = makeReqRes({ query: { limit: "10" } });

    validateQuery(schema)(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
