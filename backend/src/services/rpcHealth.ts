import { config } from "../config.js";
import { logger, redactRpcUrl } from "../logger.js";

// ── RPC endpoint health probes (#1205) ────────────────────────────────────────
//
// A failed endpoint is otherwise only discovered when a real request hits it.
// Every configured endpoint is probed with getHealth on a fixed interval. An
// endpoint that fails FAILURE_THRESHOLD probes in a row is skipped by the
// selector until one probe succeeds again.

export const RPC_HEALTH_PROBE_INTERVAL_MS = 30_000;
export const RPC_HEALTH_FAILURE_THRESHOLD = 3;
const PROBE_TIMEOUT_MS = 5_000;

const consecutiveFailures = new Map<string, number>();
let probeTimer: ReturnType<typeof setInterval> | null = null;

export function getOrderedRpcUrls(): string[] {
  const urls = [config.stellar.rpcUrl, ...config.stellar.rpcFallbacks];
  return urls.filter((u) => u.length > 0);
}

export function isEndpointHealthy(url: string): boolean {
  return (consecutiveFailures.get(url) ?? 0) < RPC_HEALTH_FAILURE_THRESHOLD;
}

export function recordProbeResult(url: string, ok: boolean): void {
  const previous = consecutiveFailures.get(url) ?? 0;

  if (ok) {
    consecutiveFailures.delete(url);
    if (previous >= RPC_HEALTH_FAILURE_THRESHOLD) {
      logger.info({ rpcUrl: redactRpcUrl(url) }, "RPC endpoint healthy again; rejoining pool");
    }
    return;
  }

  const failures = previous + 1;
  consecutiveFailures.set(url, failures);
  if (failures === RPC_HEALTH_FAILURE_THRESHOLD) {
    logger.warn(
      { rpcUrl: redactRpcUrl(url), failures },
      "RPC endpoint failed consecutive health probes; excluding from pool",
    );
  }
}

async function probeEndpoint(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;

    const body = (await response.json()) as { result?: { status?: string } };
    return body.result?.status === "healthy";
  } catch {
    return false;
  }
}

export async function probeRpcEndpoints(urls: string[] = getOrderedRpcUrls()): Promise<void> {
  await Promise.all(urls.map(async (url) => recordProbeResult(url, await probeEndpoint(url))));
}

export function startRpcHealthProbes(): void {
  if (probeTimer !== null) return;
  probeTimer = setInterval(() => {
    void probeRpcEndpoints();
  }, RPC_HEALTH_PROBE_INTERVAL_MS);
  probeTimer.unref();
}

export function stopRpcHealthProbes(): void {
  if (probeTimer !== null) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}
