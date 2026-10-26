import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { query } from "../../db/index.js";

const PURGE_INTERVAL = `INTERVAL '24 hours'`;

function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * Replays the stored response for a repeated `Idempotency-Key` with the same
 * body, and rejects reuse of a key with a different body (#1186).
 *
 * Keys are purged after 24 hours. Requests without the header, and non-POST
 * requests, pass through unchanged.
 */
export function idempotency() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header("Idempotency-Key");
    if (!key || req.method !== "POST") {
      next();
      return;
    }

    const route = `${req.method} ${req.originalUrl.split("?")[0]}`;
    const requestHash = hashRequestBody(req.body);

    try {
      await query(`DELETE FROM idempotency_keys WHERE created_at < NOW() - ${PURGE_INTERVAL}`);

      const rows = await query<{
        request_hash: string;
        response_status: number;
        response_body: unknown;
      }>(
        `SELECT request_hash, response_status, response_body
           FROM idempotency_keys
          WHERE key = $1 AND route = $2`,
        [key, route],
      );

      if (rows.length > 0) {
        const row = rows[0];
        if (row.request_hash !== requestHash) {
          res.status(422).json({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "Idempotency-Key was already used with a different request body",
            statusCode: 422,
          });
          return;
        }
        res.status(row.response_status).json(row.response_body);
        return;
      }

      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        res.json = originalJson;
        query(
          `INSERT INTO idempotency_keys (key, route, request_hash, response_status, response_body)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (key, route) DO NOTHING`,
          [key, route, requestHash, res.statusCode, JSON.stringify(body ?? null)],
        ).catch(() => undefined);
        return originalJson(body);
      }) as Response["json"];

      next();
    } catch (err) {
      next(err);
    }
  };
}
