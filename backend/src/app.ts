import compression from "compression";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { printSchema } from "graphql";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { healthRouter } from "./api/routes/health.js";
import { vaultsRouter } from "./api/routes/vaults.js";
import { usersRouter } from "./api/routes/users.js";
import { yieldsRouter } from "./api/routes/yields.js";
import { adminRouter } from "./api/routes/admin.js";
import { factoryRouter } from "./api/routes/factory.js";
import { webhooksRouter } from "./api/routes/webhooks.js";
import { validateRouter } from "./api/routes/validate.js";
import { codegenRouter } from "./api/routes/codegen.js";
import { notificationsRouter } from "./api/routes/notifications.js";
import { analyticsRouter } from "./api/routes/analytics.js";
import { proxyRouter } from "./api/routes/proxy.js";
import { errorHandler } from "./api/middleware/errors.js";
import { requestId } from "./api/middleware/requestId.js";
import { requestContext } from "./api/middleware/requestContext.js";
import { responseSizeLimit } from "./api/middleware/responseSizeLimit.js";
import { cacheControl } from "./api/middleware/cacheControl.js";
import { internalAuth } from "./api/middleware/internalAuth.js";
import { internalRouter } from "./api/routes/internal.js";
import { publicLimiter, authLimiter } from "./api/middleware/rateLimit.js";
import { staticCacheMiddleware, cacheResponse, getCachedResponse } from "./api/middleware/responseCache.js";
import { queryTimeoutMiddleware } from "./api/middleware/queryTimeout.js";

// Cache static responses at startup
function initStaticCache(): void {
  const openapiSpec = {
    openapi: "3.0.3",
    info: { title: "StellarYield API", version: "1.0.0" },
    paths: {},
  };
  cacheResponse("openapi.json", openapiSpec, 200, { "Content-Type": "application/json" });

  const changelog = { version: "1.0.0", changes: [] };
  cacheResponse("changelog", changelog, 200, { "Content-Type": "application/json" });
}

initStaticCache();
import { httpRequestsTotal, getMetrics } from "./services/metrics.js";
import { setupOpenApiRoutes } from "./services/openapi.js";
import { schema } from "./graphql/schema.js";
import { apolloMiddleware } from "./graphql/apolloServer.js";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(pinoHttp({ logger }));

  // Response compression (#948). Large list responses (vault lists, event logs)
  // are verbose JSON; gzip/deflate cuts bandwidth for every client. Only
  // payloads larger than 1 KB are compressed, and `Vary: Accept-Encoding` is
  // set on every response so shared caches key on the client's encoding.
  // SSE streams are never compressed — buffering them would defeat real-time
  // delivery.
  app.use((_req, res, next) => {
    res.vary("Accept-Encoding");
    next();
  });
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        const contentType = String(res.getHeader("Content-Type") ?? "");
        if (contentType.includes("text/event-stream")) return false;
        return compression.filter(req, res);
      },
    }),
  );

  app.use(express.json({ limit: config.requestBodyLimit }));

  const origins = config.allowedOrigins;
  if (origins.length > 0) {
    const origin = origins.length === 1 && origins[0] === "*" ? "*" : origins;
    app.use(cors({ 
      origin,
      maxAge: config.cors.maxAge,
    }));
  }

  app.use(requestId);
  app.use(requestContext);
  app.use(responseSizeLimit());
  app.use(cacheControl());

  app.use((req, res, next) => {
    if (config.sandboxMode) {
      res.setHeader("X-Sandbox", "true");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        !["/api/v1/admin/session", "/api/v1/admin/session/refresh", "/api/v1/admin/sandbox/reset"].includes(req.path)
      ) {
        res.status(200).json({ success: true });
        return;
      }
    }

    res.on("finish", () => {
      const route = req.route?.path ?? req.path;
      httpRequestsTotal.inc({ method: req.method, route, status: res.statusCode });
    });
    next();
  });

  app.use("/health", publicLimiter, healthRouter);
  app.use("/api/v1/vaults", publicLimiter, vaultsRouter);
  app.use("/api/v1/users", publicLimiter, usersRouter);
  app.use("/api/v1/yields", publicLimiter, yieldsRouter);
  app.use("/api/v1/analytics", publicLimiter, analyticsRouter);
  app.use("/api/v1/factory", publicLimiter, factoryRouter);
  app.use("/api/v1/admin/notifications", authLimiter, notificationsRouter);
  app.use("/api/v1/admin", authLimiter, adminRouter);
  app.use("/api/v1/webhooks", authLimiter, webhooksRouter);
  // Request body dry run — validation only, never a side effect (#941)
  app.use("/api/v1/validate", publicLimiter, validateRouter);
  // SDK snippet generator — curl / TypeScript codegen from the OpenAPI spec (#943)
  app.use("/api/v1/codegen", publicLimiter, codegenRouter);
  app.use("/internal", authLimiter, internalAuth, internalRouter);
  // SDL export for client codegen tools (e.g. graphql-codegen); cached since the
  // schema only changes on server restart (#773). Registered before the Apollo
  // mount below so this exact sub-path is matched first (Express matches
  // `app.use("/api/graphql", ...)` as a prefix, which would otherwise shadow it).
  let cachedSchemaSdl: string | null = null;
  app.get("/api/graphql/schema", publicLimiter, (_req, res) => {
    if (cachedSchemaSdl === null) {
      cachedSchemaSdl = printSchema(schema);
    }
    res.set("Content-Type", "application/graphql");
    res.send(cachedSchemaSdl);
  });
  // GraphQL endpoint served via Apollo Server (#765). The Playground/Sandbox
  // landing page is only enabled in development (see graphql/apolloServer.ts).
  app.use("/api/graphql", publicLimiter, apolloMiddleware);
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", "text/plain");
    res.send(await getMetrics());
  });

  setupOpenApiRoutes(app);

  app.use(errorHandler);

  return app;
}
