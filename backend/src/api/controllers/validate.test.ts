import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db/index.js", () => ({ query: vi.fn() }));

async function getTestContext() {
  const { validateRequestBody } = await import("./validate.js");
  return { validateRequestBody };
}

function makeReqRes(body: unknown) {
  const req = { body } as any;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
  return { req, res, next: vi.fn() };
}

/** The single argument the controller passed to res.json(). */
function jsonBody(res: any) {
  return res.json.mock.calls[0][0];
}

const VALID_ADDRESS = `G${"A".repeat(55)}`;

describe("POST /api/v1/validate dry run (#941)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid: true with null errors for a body that satisfies the route schema", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/webhooks",
      method: "POST",
      body: { url: "https://example.com/hook", events: ["deposit"] },
    });

    validateRequestBody(req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(jsonBody(res)).toEqual({ valid: true, errors: null });
  });

  it("returns valid: false with field-level issues for an invalid body", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/webhooks",
      method: "POST",
      body: { url: "", events: [] },
    });

    validateRequestBody(req, res, next);

    const result = jsonBody(res);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // Issues carry the offending field path, so a client can highlight it.
    expect(result.errors.map((issue: { path: string[] }) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["url", "events"]),
    );
  });

  it("reports a missing required field rather than throwing", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/users/kyc/batch",
      method: "POST",
      body: { addresses: [VALID_ADDRESS] },
    });

    validateRequestBody(req, res, next);

    const result = jsonBody(res);
    expect(result.valid).toBe(false);
    expect(result.errors.some((issue: { path: string[] }) => issue.path.includes("vaultId"))).toBe(true);
  });

  it("validates against the same schema the live route uses", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/users/portfolios/batch",
      method: "POST",
      body: { addresses: [VALID_ADDRESS] },
    });

    validateRequestBody(req, res, next);

    expect(jsonBody(res)).toEqual({ valid: true, errors: null });
  });

  it("accepts a lowercase method and a route with a query string or trailing slash", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/webhooks/?foo=1",
      method: "post",
      body: { url: "https://example.com/hook", events: ["deposit"] },
    });

    validateRequestBody(req, res, next);

    expect(jsonBody(res)).toEqual({ valid: true, errors: null });
  });

  it("returns 404 when no schema is registered for the route", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/webhoks",
      method: "POST",
      body: {},
    });

    validateRequestBody(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(jsonBody(res)).toEqual({
      error: "NotFound",
      message: "No request body schema is registered for POST /api/v1/webhoks",
    });
  });

  it("returns 404 when the route exists but not for that method", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({
      route: "/api/v1/webhooks",
      method: "GET",
      body: {},
    });

    validateRequestBody(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 400 when the dry-run envelope itself is malformed", async () => {
    const { validateRequestBody } = await getTestContext();
    const { req, res, next } = makeReqRes({ method: "POST", body: {} });

    validateRequestBody(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(jsonBody(res).error).toBe("ValidationError");
  });
});

describe("POST /api/v1/validate through the app (#941)", () => {
  it("is reachable without an API key and has no side effects", async () => {
    const supertest = (await import("supertest")).default;
    const { createApp } = await import("../../app.js");
    const { query } = await import("../../db/index.js");

    const res = await supertest(createApp())
      .post("/api/v1/validate")
      .send({
        route: "/api/v1/vaults/metadata/validate",
        method: "POST",
        body: { name: "Treasury Bill A" },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, errors: null });
    // A dry run never touches the database.
    expect(query).not.toHaveBeenCalled();
  });
});
