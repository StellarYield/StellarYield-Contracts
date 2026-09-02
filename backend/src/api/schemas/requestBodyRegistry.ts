import type { ZodTypeAny } from "zod";
import {
  batchPortfoliosBodySchema,
  kycBatchBodySchema,
} from "../routes/users.js";
import {
  createWebhookSchema,
  verifySignatureSchema,
} from "../routes/webhooks.js";
import {
  bulkStatusBodySchema,
  metadataValidationSchema,
  translateErrorBodySchema,
} from "../routes/vaults.js";
import { previewSchema } from "../routes/notifications.js";

export interface RegisteredRoute {
  /** Uppercase HTTP method. */
  method: string;
  /** Express-style path, params written as `:name`. */
  path: string;
  /** The Zod schema the live route validates its request body with. */
  schema: ZodTypeAny;
}

/**
 * Request body schemas keyed by route, backing the dry-run validation
 * endpoint (#941).
 *
 * Every entry references the same schema object the live route validates
 * with, so a dry run can never drift from the real thing. Routes that take no
 * request body are deliberately absent: `POST /api/v1/validate` reports them
 * as unknown rather than pretending any body is acceptable.
 */
export const REGISTERED_ROUTES: RegisteredRoute[] = [
  { method: "POST", path: "/api/v1/users/portfolios/batch", schema: batchPortfoliosBodySchema },
  { method: "POST", path: "/api/v1/users/positions/batch", schema: batchPortfoliosBodySchema },
  { method: "POST", path: "/api/v1/users/kyc/batch", schema: kycBatchBodySchema },
  { method: "POST", path: "/api/v1/vaults/bulk/status", schema: bulkStatusBodySchema },
  { method: "POST", path: "/api/v1/vaults/metadata/validate", schema: metadataValidationSchema },
  { method: "POST", path: "/api/v1/vaults/simulate/translate-error", schema: translateErrorBodySchema },
  { method: "POST", path: "/api/v1/webhooks", schema: createWebhookSchema },
  { method: "POST", path: "/api/v1/webhooks/verify-signature", schema: verifySignatureSchema },
  { method: "POST", path: "/api/v1/admin/notifications/preview", schema: previewSchema },
];

/**
 * Normalise a caller-supplied route: drop any query string or fragment, force
 * a leading slash, collapse repeated slashes and drop a trailing one, so
 * `api/v1/webhooks/` and `/api/v1/webhooks?foo=1` both resolve.
 */
export function normalizeRoute(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0].trim();
  const collapsed = `/${withoutQuery}`.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

function pathMatches(pattern: string, route: string): boolean {
  const patternSegments = pattern.split("/");
  const routeSegments = route.split("/");
  if (patternSegments.length !== routeSegments.length) return false;

  return patternSegments.every((segment, i) =>
    segment.startsWith(":") ? routeSegments[i].length > 0 : segment === routeSegments[i],
  );
}

/**
 * Find the request body schema registered for a route, or null when the route
 * is unknown or accepts no body.
 */
export function findBodySchema(method: string, route: string): ZodTypeAny | null {
  const wantedMethod = method.trim().toUpperCase();
  const wantedRoute = normalizeRoute(route);

  const exact = REGISTERED_ROUTES.find(
    (entry) => entry.method === wantedMethod && entry.path === wantedRoute,
  );
  if (exact) return exact.schema;

  const byPattern = REGISTERED_ROUTES.find(
    (entry) => entry.method === wantedMethod && pathMatches(entry.path, wantedRoute),
  );
  return byPattern?.schema ?? null;
}
