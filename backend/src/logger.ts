import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  transport:
    config.nodeEnv !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});
