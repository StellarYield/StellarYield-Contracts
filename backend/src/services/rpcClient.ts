import { config } from "../config.js";
import { logger, redactRpcUrl } from "../logger.js";
import { rpcCallDurationSeconds, rpcCallsTotal } from "./metrics.js";
import { getOrderedRpcUrls, isEndpointHealthy } from "./rpcHealth.js";

export function isRetryableHttpStatus(status: number): boolean {
  return status >= 500;
}

export function buildTimeoutError(timeoutMs: number): Error {
  return new Error(`RPC call timed out after ${timeoutMs}ms`);
}

/**
 * Timeout for one RPC method (#1207). A method listed in RPC_TIMEOUTS_MS uses
 * its own value; any other method uses the global STELLAR_RPC_TIMEOUT_MS.
 */
export function rpcTimeoutFor(method: string): number {
  return config.stellar.rpcTimeoutsMs[method] ?? config.stellar.rpcTimeoutMs;
}

/**
 * Run an SDK RPC call and reject if it has not settled within the method's
 * timeout. The underlying request is not cancelled; its result is discarded.
 */
export async function withRpcTimeout<T>(method: string, call: () => Promise<T>): Promise<T> {
  const timeoutMs = rpcTimeoutFor(method);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(buildTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return response;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw buildTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Run one Soroban RPC call, recording its outcome and latency per method
 * (#1203). When RPC_DEBUG_LOG is on, each call also logs its method, params
 * and response size at debug level (#1206). The response size is the length of
 * the serialized decoded result, not the raw HTTP body.
 */
export async function timedRpcCall<T>(
  method: string,
  fn: () => Promise<T>,
  params?: unknown,
): Promise<T> {
  const endTimer = rpcCallDurationSeconds.startTimer({ method });
  let outcome: "success" | "error" = "error";
  let result: T | undefined;
  try {
    result = await fn();
    outcome = "success";
    return result;
  } finally {
    endTimer();
    rpcCallsTotal.inc({ method, outcome });
    if (config.stellar.rpcDebugLog) {
      logger.debug(
        { rpcMethod: method, rpcParams: params, outcome, responseBytes: serializedSize(result) },
        "RPC call",
      );
    }
  }
}

function serializedSize(value: unknown): number | undefined {
  try {
    const json = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
    return json === undefined ? 0 : Buffer.byteLength(json);
  } catch {
    return undefined;
  }
}

/**
 * Execute an RPC call against the list of endpoints with automatic failover.
 * Always tries the primary first. On any error, falls back to alternatives
 * in order. Logs a warning each time a fallback is used.
 *
 * Endpoints that failed consecutive health probes are skipped (#1205). If every
 * endpoint is marked unhealthy, all of them are tried rather than failing
 * without sending a request.
 *
 * The callback `fn` receives the endpoint URL and must implement its own
 * timeout logic.
 */
export async function tryRpcEndpoints<T>(
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const configuredUrls = getOrderedRpcUrls();
  if (configuredUrls.length === 0) {
    throw new Error("No RPC endpoints configured");
  }

  const healthyUrls = configuredUrls.filter(isEndpointHealthy);
  const urls = healthyUrls.length > 0 ? healthyUrls : configuredUrls;

  let lastError: Error | undefined;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const isFallback = i > 0;

    if (isFallback) {
      logger.warn(
        { rpcUrl: redactRpcUrl(url), primaryUrl: redactRpcUrl(configuredUrls[0]) },
        "RPC fallback — primary endpoint failed, trying fallback",
      );
    }

    try {
      const result = await fn(url);
      return result;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (i === urls.length - 1) throw lastError;
    }
  }

  throw lastError ?? new Error("All RPC endpoints failed");
}

/**
 * Fetch-based RPC call with timeout and failover support.
 * Used by the indexer's raw JSON-RPC client.
 */
export async function rpcFetch(body: object): Promise<Response> {
  const timeoutMs = config.stellar.rpcTimeoutMs;

  return tryRpcEndpoints(async (endpointUrl) => {
    const response = await fetchWithTimeout(
      endpointUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      timeoutMs,
    );

    if (!response.ok && isRetryableHttpStatus(response.status)) {
      throw new Error(
        `RPC request failed: ${response.status} ${response.statusText}`,
      );
    }

    return response;
  });
}
