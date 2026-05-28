import cors from "cors";
import express, { type Express } from "express";
import { config } from "./config.js";
import { healthRouter } from "./api/routes/health.js";
import { vaultsRouter } from "./api/routes/vaults.js";
import { usersRouter } from "./api/routes/users.js";
import { yieldsRouter } from "./api/routes/yields.js";
import { errorHandler } from "./api/middleware/errors.js";

export function createApp(): Express {
  const app = express();

  app.use(express.json());

  const origins = config.allowedOrigins;
  if (origins.length > 0) {
    const origin = origins.length === 1 && origins[0] === "*" ? "*" : origins;
    app.use(cors({ origin }));
  }

  app.use("/health", healthRouter);
  app.use("/api/v1/vaults", vaultsRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/yields", yieldsRouter);

  app.use(errorHandler);

  return app;
}
