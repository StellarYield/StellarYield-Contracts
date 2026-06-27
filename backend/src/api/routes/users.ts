import { Router } from "express";
import { z } from "zod";
import {
  getKycBatch,
  getPortfoliosBatch,
  getUser,
  getUserKyc,
  getUserPortfolio,
  getUserShareHistory,
  getUserYieldHistory,
  searchUsers,
} from "../controllers/users.js";
import {
  validateBody,
  validateParams,
  validateQuery,
  stellarAddressSchema,
} from "../middleware/validate.js";

export const usersRouter = Router();

const addressParamSchema = z.object({
  address: stellarAddressSchema,
});

const batchPortfoliosBodySchema = z.object({
  addresses: z
    .array(stellarAddressSchema)
    .min(1, "At least one address is required")
    .max(50, "A maximum of 50 addresses is allowed"),
});

const searchQuerySchema = z.object({
  search: z.string().min(4, "Search query must be at least 4 characters long"),
});

const kycQuerySchema = z.object({
  vaultId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/),
});

const kycBatchBodySchema = z.object({
  addresses: z
    .array(stellarAddressSchema)
    .min(1, "At least one address is required")
    .max(50, "A maximum of 50 addresses is allowed"),
  vaultId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/, "Invalid vault contract ID"),
});

const yieldHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((v) => Math.min(v, 50)),
});

const shareHistoryQuerySchema = z.object({
  vaultId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/).optional(),
});

usersRouter.get("/", validateQuery(searchQuerySchema), searchUsers);
usersRouter.post(
  "/portfolios/batch",
  validateBody(batchPortfoliosBodySchema),
  getPortfoliosBatch,
);
usersRouter.post(
  "/kyc/batch",
  validateBody(kycBatchBodySchema),
  getKycBatch,
);
usersRouter.get(
  "/:address/kyc",
  validateParams(addressParamSchema),
  validateQuery(kycQuerySchema),
  getUserKyc,
);
usersRouter.get(
  "/:address/yield-history",
  validateParams(addressParamSchema),
  validateQuery(yieldHistoryQuerySchema),
  getUserYieldHistory,
);
usersRouter.get(
  "/:address/share-history",
  validateParams(addressParamSchema),
  validateQuery(shareHistoryQuerySchema),
  getUserShareHistory,
);
usersRouter.get("/:address", validateParams(addressParamSchema), getUser);
usersRouter.get(
  "/:address/portfolio",
  validateParams(addressParamSchema),
  getUserPortfolio,
);
