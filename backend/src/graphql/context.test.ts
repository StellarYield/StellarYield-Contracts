import { describe, it, expect, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../db/index.js", () => ({ query: queryMock }));

const { createGraphQLContext } = await import("./context.js");

describe("createGraphQLContext - #772", () => {
  it("attaches the role for a valid API key", async () => {
    queryMock.mockResolvedValueOnce([{ role: "admin" }]);
    const context = await createGraphQLContext({ raw: { headers: { authorization: "Bearer validkey" } } as any });
    expect(context).toEqual({ role: "admin" });
  });

  it("returns a null role when no Authorization header is present", async () => {
    const context = await createGraphQLContext({ raw: { headers: {} } as any });
    expect(context).toEqual({ role: null });
  });

  it("returns a null role for an unknown API key", async () => {
    queryMock.mockResolvedValueOnce([]);
    const context = await createGraphQLContext({ raw: { headers: { authorization: "Bearer badkey" } } as any });
    expect(context).toEqual({ role: null });
  });
});
