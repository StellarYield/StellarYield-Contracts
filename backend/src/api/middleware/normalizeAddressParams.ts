import type { NextFunction, Request, Response } from "express";

export function normalizeAddressParam(paramName: string) {
  return (req: Request, _res: Response, next: NextFunction, value: string) => {
    if (typeof value === "string" && value.length > 0) {
      req.params[paramName] = value.toUpperCase();
    }
    next();
  };
}

export const normalizeAddressParams = [
  normalizeAddressParam("address"),
  normalizeAddressParam("contractId"),
];
