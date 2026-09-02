import { describe, it, expect } from "vitest";
import { generateSnippet, findRoute } from "./codegen.js";

const BASE = "https://api.stellaryield.test";

describe("SDK snippet generator (#943)", () => {
  describe("route resolution against the OpenAPI spec", () => {
    it("matches a route by its path-parameter pattern", () => {
      const match = findRoute("GET", "/api/v1/vaults/{contractId}");
      expect(match?.templatePath).toBe("/api/v1/vaults/{contractId}");
      expect(match?.method).toBe("GET");
    });

    it("accepts the :param convention as well as {param}", () => {
      expect(findRoute("get", "/api/v1/vaults/:contractId")?.templatePath).toBe(
        "/api/v1/vaults/{contractId}",
      );
    });

    it("returns null for a route the spec does not document", () => {
      expect(findRoute("GET", "/api/v1/not-a-real-route")).toBeNull();
    });

    it("returns null when the path exists but not for that method", () => {
      expect(findRoute("DELETE", "/api/v1/vaults")).toBeNull();
    });
  });

  describe("curl", () => {
    it("produces a valid curl command with the resolved URL", () => {
      const result = generateSnippet({
        route: "/api/v1/vaults/{contractId}",
        method: "GET",
        params: { contractId: "CABC123" },
        language: "curl",
        baseUrl: BASE,
      });

      expect(result?.snippet).toBe(`curl -X GET '${BASE}/api/v1/vaults/CABC123'`);
      expect(result?.url).toBe(`${BASE}/api/v1/vaults/CABC123`);
    });

    it("appends documented query parameters", () => {
      const result = generateSnippet({
        route: "/api/v1/vaults",
        method: "GET",
        params: { page: 2, pageSize: 50, bogus: "dropped" },
        language: "curl",
        baseUrl: BASE,
      });

      expect(result?.snippet).toContain(`'${BASE}/api/v1/vaults?page=2&pageSize=50'`);
      expect(result?.snippet).not.toContain("bogus");
    });

    it("adds Content-Type and an Authorization header for a protected write route", () => {
      const result = generateSnippet({
        route: "/api/v1/webhooks",
        method: "POST",
        params: { url: "https://example.com/hook", events: ["deposit"] },
        language: "curl",
        baseUrl: BASE,
      });

      expect(result?.snippet).toContain("curl -X POST");
      expect(result?.snippet).toContain("-H 'Content-Type: application/json'");
      expect(result?.snippet).toContain('-H "Authorization: Bearer $STELLARYIELD_API_KEY"');
      expect(result?.snippet).toContain(
        `-d '{"url":"https://example.com/hook","events":["deposit"]}'`,
      );
    });

    it("leaves a readable placeholder when a path parameter is not supplied", () => {
      const result = generateSnippet({
        route: "/api/v1/vaults/{contractId}",
        method: "GET",
        language: "curl",
        baseUrl: BASE,
      });

      expect(result?.snippet).toContain(`${BASE}/api/v1/vaults/:contractId`);
    });
  });

  describe("typescript", () => {
    it("produces a fetch call with method and no auth for a public GET", () => {
      const result = generateSnippet({
        route: "/api/v1/vaults/{contractId}",
        method: "GET",
        params: { contractId: "CABC123" },
        language: "typescript",
        baseUrl: BASE,
      });

      expect(result?.snippet).toContain(
        `const response = await fetch("${BASE}/api/v1/vaults/CABC123", {`,
      );
      expect(result?.snippet).toContain(`method: "GET",`);
      expect(result?.snippet).toContain("const data = await response.json();");
      expect(result?.snippet).not.toContain("Authorization");
    });

    it("includes headers and a JSON body for a protected write route", () => {
      const result = generateSnippet({
        route: "/api/v1/webhooks",
        method: "POST",
        params: { url: "https://example.com/hook", events: ["deposit"] },
        language: "typescript",
        baseUrl: BASE,
      });

      expect(result?.snippet).toContain(`method: "POST",`);
      expect(result?.snippet).toContain(`"Content-Type": "application/json",`);
      expect(result?.snippet).toContain(
        '"Authorization": `Bearer ${process.env.STELLARYIELD_API_KEY}`,',
      );
      expect(result?.snippet).toContain("body: JSON.stringify(");
      expect(result?.snippet).toContain('"url": "https://example.com/hook"');
    });
  });

  it("returns null for an unknown route", () => {
    expect(
      generateSnippet({
        route: "/api/v1/nope",
        method: "GET",
        language: "curl",
        baseUrl: BASE,
      }),
    ).toBeNull();
  });
});
