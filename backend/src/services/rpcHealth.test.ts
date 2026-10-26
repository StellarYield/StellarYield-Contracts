import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isEndpointHealthy,
  probeRpcEndpoints,
  recordProbeResult,
  RPC_HEALTH_FAILURE_THRESHOLD,
} from "./rpcHealth.js";

function healthResponse(status: string): Response {
  return new Response(JSON.stringify({ result: { status } }));
}

describe("RPC endpoint health tracking (#1205)", () => {
  it("excludes an endpoint only once the failure threshold is reached", () => {
    const url = "https://threshold.example";

    for (let i = 1; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) {
      recordProbeResult(url, false);
      expect(isEndpointHealthy(url)).toBe(true);
    }

    recordProbeResult(url, false);
    expect(isEndpointHealthy(url)).toBe(false);
  });

  it("rejoins the pool after a single successful probe", () => {
    const url = "https://rejoin.example";
    for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) recordProbeResult(url, false);

    recordProbeResult(url, true);

    expect(isEndpointHealthy(url)).toBe(true);
  });

  it("requires consecutive failures, so a success resets the count", () => {
    const url = "https://reset.example";
    recordProbeResult(url, false);
    recordProbeResult(url, false);
    recordProbeResult(url, true);

    recordProbeResult(url, false);
    recordProbeResult(url, false);

    expect(isEndpointHealthy(url)).toBe(true);
  });
});

describe("probeRpcEndpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a getHealth JSON-RPC request to each endpoint", async () => {
    const fetchMock = vi.fn(async () => healthResponse("healthy"));
    vi.stubGlobal("fetch", fetchMock);

    await probeRpcEndpoints(["https://probe-body.example"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://probe-body.example");
    expect(JSON.parse(init.body as string)).toMatchObject({ method: "getHealth" });
  });

  it("counts a status other than healthy as a failed probe", async () => {
    const url = "https://probe-status.example";
    vi.stubGlobal("fetch", vi.fn(async () => healthResponse("unhealthy")));

    for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) await probeRpcEndpoints([url]);

    expect(isEndpointHealthy(url)).toBe(false);
  });

  it("counts a network error as a failed probe, and a healthy reply as recovery", async () => {
    const url = "https://probe-network.example";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    for (let i = 0; i < RPC_HEALTH_FAILURE_THRESHOLD; i++) await probeRpcEndpoints([url]);
    expect(isEndpointHealthy(url)).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => healthResponse("healthy")));
    await probeRpcEndpoints([url]);
    expect(isEndpointHealthy(url)).toBe(true);
  });
});
