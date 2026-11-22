import type { Request, Response, NextFunction } from "express";
import { config } from "../../config.js";

/** Request body shape this middleware inspects. `url` is validated below. */
interface WebhookRegistrationBody {
  url?: unknown;
}

export function webhookHttpsEnforcement() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const isProduction = config.nodeEnv === "production";

    if (!isProduction) {
      next();
      return;
    }

    if (req.method !== "POST" && req.method !== "PUT") {
      next();
      return;
    }

    const body: WebhookRegistrationBody | null | undefined = req.body;
    if (!body || typeof body !== "object") {
      next();
      return;
    }

    const url = body.url;
    if (!url || typeof url !== "string") {
      next();
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      next();
      return;
    }

    if (parsed.protocol === "http:") {
      res.status(422).json({
        error: "UnprocessableEntity",
        message: "Webhook URLs must use HTTPS in production mode",
      });
      return;
    }

    next();
  };
}
