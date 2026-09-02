import type { Request, Response, NextFunction, Express } from "express";
import { z } from "zod";
import request from "supertest";

const proxyRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

const SENSITIVE_HEADERS = ["authorization", "cookie", "x-api-key"];

let cachedApp: Express | null = null;

async function getApp(): Promise<Express> {
  if (!cachedApp) {
    const { createApp } = await import("../../app.js");
    cachedApp = createApp();
  }
  return cachedApp;
}

export async function proxyRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = proxyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "BadRequest", message: "Invalid request body" });
      return;
    }

    const { method, path, headers, body } = parsed.data;

    // Validate path starts with /api/v1/
    if (!path.startsWith("/api/v1/")) {
      res.status(400).json({ error: "BadRequest", message: "Path must start with /api/v1/" });
      return;
    }

    // Prevent infinite loop - cannot proxy to itself
    if (path === "/api/v1/proxy") {
      res.status(403).json({ error: "Forbidden", message: "Cannot proxy to /api/v1/proxy itself" });
      return;
    }

    // Strip sensitive headers (case-insensitive)
    const safeHeaders: Record<string, string> = {};
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (!SENSITIVE_HEADERS.includes(key.toLowerCase())) {
          safeHeaders[key] = value;
        }
      }
    }

    // Create internal request using supertest
    const app = await getApp();
    let testRequest = request(app)[method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete"](path);

    // Apply headers
    for (const [key, value] of Object.entries(safeHeaders)) {
      testRequest = testRequest.set(key, value);
    }

    // Apply body for methods that support it
    if (body !== undefined && body !== null && ["POST", "PUT", "PATCH"].includes(method)) {
      testRequest = testRequest.send(body);
    }

    // Execute the request
    const response = await testRequest;

    // Return proxied response
    res.json({
      status: response.status,
      headers: response.headers,
      body: response.body,
    });
  } catch (err) {
    next(err);
  }
}
