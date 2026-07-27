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
import { analyticsRouter } from "./api/routes/analytics.js";
import { factoryRouter } from "./api/routes/factory.js";
import { errorHandler } from "./api/middleware/errors.js";
import { requestId } from "./api/middleware/requestId.js";
import { internalAuth } from "./api/middleware/internalAuth.js";
import { internalRouter } from "./api/routes/internal.js";
import { publicLimiter, authLimiter } from "./api/middleware/rateLimit.js";
import { httpRequestsTotal, getMetrics } from "./services/metrics.js";
import { setupOpenApiRoutes } from "./services/openapi.js";
import { schema } from "./graphql/schema.js";
import { apolloMiddleware } from "./graphql/apolloServer.js";

export function createApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(pinoHttp({ logger }));
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

  app.use((req, res, next) => {
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
  app.use("/api/v1/admin", authLimiter, adminRouter);
  app.use("/api/v1/factory", publicLimiter, factoryRouter);
  app.use("/api/v1/webhooks", authLimiter, webhooksRouter);
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
