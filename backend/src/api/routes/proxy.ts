import { Router } from "express";
import { proxyRequest } from "../controllers/proxy.js";
import { requireApiKey } from "../middleware/auth.js";

export const proxyRouter = Router();

proxyRouter.post("/", requireApiKey(), proxyRequest);
