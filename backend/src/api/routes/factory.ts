import { Router } from "express";
import { z } from "zod";
import {
  getFactoryAdminHistory,
  getVaultCreationRate,
  getFactoryDefaults,
  getFactoryEvents,
} from "../controllers/factory.js";
import { validateQuery } from "../middleware/validate.js";
import { requireApiKey } from "../middleware/auth.js";

const factoryEventsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((value) => Math.min(value, 100)),
});

export const factoryRouter = Router();

// Reverse-chronological admin transfer log for audits (#839)
factoryRouter.get("/admin-history", requireApiKey(), getFactoryAdminHistory);
// Vault deployment rate over rolling 24h/7d/30d windows (#840)
factoryRouter.get("/vault-creation-rate", getVaultCreationRate);
// Canonical default vault parameters sourced from the latest def_upd event (#841)
factoryRouter.get("/defaults", getFactoryDefaults);
// Paginated, reverse-ledger-order factory event log (#842)
factoryRouter.get("/events", requireApiKey(), validateQuery(factoryEventsQuerySchema), getFactoryEvents);
