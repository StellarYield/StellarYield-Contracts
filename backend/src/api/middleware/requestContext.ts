import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, Response, NextFunction } from "express";

export interface RequestStore {
  route: string;
  method: string;
}

export const requestStore = new AsyncLocalStorage<RequestStore>();

export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  const route = req.originalUrl || req.baseUrl + req.path || req.path;
  requestStore.run({ route, method: req.method.toUpperCase() }, () => {
    next();
  });
}

export function getCurrentRoute(): string | null {
  const store = requestStore.getStore();
  return store ? store.route : null;
}

export function getCurrentMethod(): string | null {
  const store = requestStore.getStore();
  return store ? store.method : null;
}
