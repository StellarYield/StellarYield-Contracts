import { Router } from "express";
import { z } from "zod";
import {
  exportUserData,
  getKycBatch,
  getPortfoliosBatch,
  getPositionsBatch,
  getUser,
  getUserIncomeForecast,
  getUserKyc,
  getUserKycHistory,
  getUserPortfolio,
  getUserPortfolioAllocation,
  getUserPortfolioDiversification,
  getUserPortfolioPnl,
  getUserShareHistory,
  getUserYieldHistory,
  getUserYieldSummary,
  getUserYieldBreakdown,
  searchUsers,
  streamUserPositions,
} from "../controllers/users.js";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  createVaultSubscription,
  deleteVaultSubscription,
  listVaultSubscriptions,
} from "../controllers/userNotifications.js";
import {
  validateBody,
  validateParams,
  validateQuery,
  stellarAddressSchema,
} from "../middleware/validate.js";
import { requireApiKey } from "../middleware/auth.js";

export const usersRouter = Router();

const addressParamSchema = z.object({
  address: stellarAddressSchema,
});

const subscriptionParamsSchema = z.object({
  address: stellarAddressSchema,
  contractId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/, "Invalid vault contract ID"),
});

export const batchPortfoliosBodySchema = z.object({
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

export const kycBatchBodySchema = z.object({
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

const kycHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).default(20).transform((v) => Math.min(v, 50)),
});

const shareHistoryQuerySchema = z.object({
  vaultId: z.string().length(56).regex(/^C[A-Z2-7]{55}$/).optional(),
});

const yieldBreakdownQuerySchema = z.object({
  vaultId: z
    .string()
    .length(56)
    .regex(/^C[A-Z2-7]{55}$/, "Invalid vault contract ID"),
});

usersRouter.get("/", validateQuery(searchQuerySchema), searchUsers);
usersRouter.post(
  "/portfolios/batch",
  validateBody(batchPortfoliosBodySchema),
  getPortfoliosBatch,
);
usersRouter.post(
  "/positions/batch",
  validateBody(batchPortfoliosBodySchema),
  getPositionsBatch,
);
usersRouter.post(
  "/kyc/batch",
  validateBody(kycBatchBodySchema),
  getKycBatch,
);
usersRouter.get(
  "/:address/data-export",
  requireApiKey({ role: "admin" }),
  validateParams(addressParamSchema),
  exportUserData,
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
  "/:address/yield-summary",
  validateParams(addressParamSchema),
  getUserYieldSummary,
);
usersRouter.get(
  "/:address/yield-breakdown",
  validateParams(addressParamSchema),
  validateQuery(yieldBreakdownQuerySchema),
  getUserYieldBreakdown,
);
usersRouter.get(
  "/:address/kyc-history",
  validateParams(addressParamSchema),
  validateQuery(kycHistoryQuerySchema),
  getUserKycHistory,
);
usersRouter.get(
  "/:address/share-history",
  validateParams(addressParamSchema),
  validateQuery(shareHistoryQuerySchema),
  getUserShareHistory,
);
usersRouter.get(
  "/:address/notification-preferences",
  validateParams(addressParamSchema),
  getNotificationPreferences,
);
usersRouter.put(
  "/:address/notification-preferences",
  validateParams(addressParamSchema),
  updateNotificationPreferences,
);
usersRouter.get(
  "/:address/subscriptions",
  validateParams(addressParamSchema),
  listVaultSubscriptions,
);
usersRouter.post(
  "/:address/subscriptions",
  validateParams(addressParamSchema),
  createVaultSubscription,
);
usersRouter.delete(
  "/:address/subscriptions/:contractId",
  validateParams(subscriptionParamsSchema),
  deleteVaultSubscription,
);
usersRouter.get("/:address", validateParams(addressParamSchema), getUser);
usersRouter.get(
  "/:address/portfolio",
  validateParams(addressParamSchema),
  getUserPortfolio,
);
usersRouter.get(
  "/:address/portfolio/pnl",
  validateParams(addressParamSchema),
  getUserPortfolioPnl,
);
usersRouter.get(
  "/:address/portfolio/allocation",
  validateParams(addressParamSchema),
  getUserPortfolioAllocation,
);
usersRouter.get(
  "/:address/portfolio/diversification",
  validateParams(addressParamSchema),
  getUserPortfolioDiversification,
);
usersRouter.get(
  "/:address/portfolio/income-forecast",
  validateParams(addressParamSchema),
  getUserIncomeForecast,
);
usersRouter.get(
  "/:address/stream",
  validateParams(addressParamSchema),
  streamUserPositions,
);
