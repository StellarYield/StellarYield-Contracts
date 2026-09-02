import { Router } from "express";
import { validateRequestBody } from "../controllers/validate.js";

export const validateRouter = Router();

/** POST /api/v1/validate — request body dry run, no side effects (#941) */
validateRouter.post("/", validateRequestBody);
