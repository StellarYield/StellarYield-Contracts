import { Router } from "express";
import { generateCodeSnippet } from "../controllers/codegen.js";

export const codegenRouter = Router();

/** POST /api/v1/codegen — SDK snippet generator, OpenAPI spec as template (#943) */
codegenRouter.post("/", generateCodeSnippet);
