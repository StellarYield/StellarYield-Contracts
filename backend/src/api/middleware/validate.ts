import type { Request, Response, NextFunction } from "express";
import type { ZodSchema, ZodIssue } from "zod";
import { z } from "zod";
import { classifyAddress } from "../../utils/address.js";
import { config } from "../../config.js";

export const MUXED_ADDRESS_NOT_SUPPORTED = "MUXED_ADDRESS_NOT_SUPPORTED";

type IssueWithParams = ZodIssue & { params?: { code?: string; httpStatus?: number } };

function sendIssues(res: Response, issues: ZodIssue[]) {
  const typed = issues as IssueWithParams[];
  const muxed = typed.find((i) => i.params?.code === MUXED_ADDRESS_NOT_SUPPORTED);
  if (muxed) {
    res.status(422).json({
      code: MUXED_ADDRESS_NOT_SUPPORTED,
      message: "Muxed addresses (M...) are not supported; use a plain account address (G...)",
      statusCode: 422,
    });
    return;
  }
  const status = typed.some((i) => i.params?.httpStatus === 422) ? 422 : 400;
  res.status(status).json({ error: "ValidationError", issues });
}

// Stellar address validator: Valid account address (G...) checked via classifyAddress.
// Muxed (M...) addresses are rejected with a dedicated error code so clients can
// tell them apart from malformed input (#1188).
export const stellarAddressSchema = z
  .string()
  .superRefine((val, ctx) => {
    const kind = classifyAddress(val);
    if (kind === "muxed" || val.startsWith("M")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Muxed addresses are not supported",
        params: { code: MUXED_ADDRESS_NOT_SUPPORTED, httpStatus: 422 },
      });
      return;
    }
    if (kind !== "account") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Stellar address format",
      });
    }
  });

// Stellar contract address validator: Valid contract address (C...) checked via classifyAddress
export const contractAddressSchema = z
  .string()
  .refine((val) => classifyAddress(val) === "contract", {
    message: "Invalid Stellar contract address format",
  });

/**
 * Zod transform that normalises a free-text string to Unicode NFC (#1236).
 * Visually identical names in different compositions (e.g. é = e + combining
 * accent vs. precomposed é) are reduced to the same canonical form before
 * storage, so uniqueness checks and searches work correctly regardless of how
 * a client encoded the character.
 *
 * Usage: z.string().transform(nfcNormalize)
 *         or: nfcStringSchema
 */
export function nfcNormalize(value: string): string {
  return value.normalize("NFC");
}

/** A string field that is automatically NFC-normalised on parse (#1236). */
export const nfcStringSchema = z.string().transform(nfcNormalize);

/**
 * Maximum allowed span for a date-range query (in days, inclusive) (#1235).
 * Requests spanning more than this many days return HTTP 422.
 */
export const MAX_DATE_RANGE_DAYS = 366;

/**
 * Shared date-range schema for endpoints that accept `from` / `to` Unix
 * timestamps (seconds). Enforces:
 *   - `from <= to`
 *   - span ≤ MAX_DATE_RANGE_DAYS
 * (#1235)
 */
export const dateRangeSchema = z
  .object({
    from: z.coerce.number().int().optional(),
    to: z.coerce.number().int().optional(),
  })
  .superRefine((data, ctx) => {
    const { from, to } = data;
    if (from !== undefined && to !== undefined) {
      if (from > to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "`from` must not be after `to`",
          path: ["from"],
        });
        return;
      }
      const spanDays = (to - from) / 86_400;
      if (spanDays > MAX_DATE_RANGE_DAYS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Date range must not exceed ${MAX_DATE_RANGE_DAYS} days (requested ${Math.ceil(spanDays)})`,
          path: ["to"],
        });
      }
    }
  });

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      sendIssues(res, result.error.issues);
      return;
    }
    req.body = result.data;
    next();
  };
}

function knownQueryKeys(schema: ZodSchema): Set<string> | null {
  const s = schema as unknown as {
    _def?: { typeName?: string; schema?: ZodSchema; shape?: () => Record<string, unknown> };
    shape?: Record<string, unknown>;
  };
  if (s?._def?.typeName === "ZodObject") {
    const shape = s.shape ?? s._def.shape?.();
    return new Set(Object.keys(shape ?? {}));
  }
  if (s?._def?.schema) {
    return knownQueryKeys(s._def.schema);
  }
  return null;
}

export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Reject query keys absent from the route's Zod schema when strict mode is
    // enabled, so typos like `?limt=10` are not silently ignored (#1185).
    if (config.strictQueryParams) {
      const known = knownQueryKeys(schema);
      if (known) {
        const unknownKeys = Object.keys(req.query).filter((k) => !known.has(k));
        if (unknownKeys.length > 0) {
          res.status(422).json({
            code: "UNKNOWN_QUERY_PARAMS",
            message: `Unknown query parameters: ${unknownKeys.join(", ")}`,
            unknownParams: unknownKeys,
            statusCode: 422,
          });
          return;
        }
      }
    }

    // Detect duplicate scalar query parameters (#1238).
    // Express parses `?limit=10&limit=500` as `{ limit: ["10", "500"] }`.
    // A schema that expects a scalar (non-array) type would silently use the
    // first value or fail with a confusing type error. Reject early instead.
    const duplicates: string[] = [];
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        // Check whether the schema's shape declares this key as an array.
        // If the schema has no shape (e.g. z.record), skip the check.
        const shape = (schema as any)._def?.shape?.();
        const fieldDef = shape?.[key]?._def;
        // ZodArray inner type is stored under _def.type === "ZodArray".
        const isArrayType = fieldDef?.typeName === "ZodArray";
        if (!isArrayType) {
          duplicates.push(key);
        }
      }
    }
    if (duplicates.length > 0) {
      res.status(422).json({
        error: "DuplicateQueryParameter",
        message: `Scalar query parameter(s) must not appear more than once: ${duplicates.join(", ")}`,
        params: duplicates,
      });
      return;
    }

    const result = schema.safeParse(req.query);
    if (!result.success) {
      sendIssues(res, result.error.issues);
      return;
    }
    req.query = result.data;
    next();
  };
}

export function validateParams(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      sendIssues(res, result.error.issues);
      return;
    }
    req.params = result.data;
    next();
  };
}
