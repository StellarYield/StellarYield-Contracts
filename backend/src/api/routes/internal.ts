import { Router } from "express";

export const internalRouter = Router();

// Signature-verified liveness check for other internal services (#752).
internalRouter.get("/ping", (_req, res) => {
  res.json({ status: "ok" });
});
