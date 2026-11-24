import { Router } from "express";
import { z } from "zod";
import {
  deleteUserGdprData,
  exportUserGdprData,
  gdprErasureQuerySchema,
} from "../controllers/gdpr.js";
import { validateParams, validateQuery, stellarAddressSchema } from "../middleware/validate.js";
import { requireApiKey } from "../middleware/auth.js";
import { ipAllowlist } from "../middleware/ipAllowlist.js";
import { normalizeAddressParam } from "../middleware/normalizeAddressParams.js";

/** GDPR data subject rights (#1110 export, #1111 erasure), mounted at /api/v1/gdpr. */
export const gdprRouter = Router();
gdprRouter.param("address", normalizeAddressParam("address"));

const addressParamSchema = z.object({
  address: stellarAddressSchema,
});

// Reading or erasing another subject's personal data is an administrative
// action: same IP allowlist and admin-key requirement as the rest of the
// administrative surface.
gdprRouter.use(ipAllowlist());
gdprRouter.use(requireApiKey({ role: "admin" }));

/** GET /api/v1/gdpr/users/:address/export — portable copy of all subject data (Art. 20). */
gdprRouter.get(
  "/users/:address/export",
  validateParams(addressParamSchema),
  exportUserGdprData,
);

/** DELETE /api/v1/gdpr/users/:address?confirm=true — right to erasure (Art. 17). */
gdprRouter.delete(
  "/users/:address",
  validateParams(addressParamSchema),
  validateQuery(gdprErasureQuerySchema),
  deleteUserGdprData,
);
