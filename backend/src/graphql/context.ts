import { createHash } from "crypto";
import type { Request as ExpressRequest } from "express";
import { query } from "../db/index.js";

export interface GraphQLContext {
  [key: string]: unknown;
  [key: number]: unknown;
  [key: symbol]: unknown;
  role: string | null;
}

/**
 * Builds the per-request GraphQL context by resolving the `Authorization: Bearer <key>`
 * header to an API key role, mirroring the REST `requireApiKey` middleware (#772).
 */
export async function createGraphQLContext(req: { raw: ExpressRequest }): Promise<GraphQLContext> {
  const authHeader = req.raw.headers.authorization;
  const headerValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;

  if (!headerValue?.startsWith("Bearer ")) {
    return { role: null };
  }

  const keyHash = createHash("sha256").update(headerValue.slice(7)).digest("hex");
  const rows = await query<{ role: string }>(
    "SELECT role FROM api_keys WHERE key_hash = $1",
    [keyHash],
  ).catch(() => []);

  return { role: rows[0]?.role ?? null };
}
