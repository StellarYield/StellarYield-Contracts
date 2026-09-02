import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const errors = new Counter("event_indexer_errors");
const latency = new Trend("event_indexer_latency", true);

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "";
const P95_THRESHOLD = parseInt(__ENV.P95_THRESHOLD_MS || "500", 10);

export const options = {
  vus: 20,
  duration: "120s",
};

export default function () {
  const url = `${BASE_URL}/api/v1/admin/events`;
  const params = {
    headers: {
      Accept: "application/json",
      ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
  };

  const res = http.get(url, params);
  latency.add(res.timings.duration);

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "p95 latency OK": (r) => r.timings.duration <= P95_THRESHOLD,
  });

  if (!ok) {
    errors.add(1);
  }
}

export function handleSummary(data) {
  const p95 = data.metrics["event_indexer_latency"]?.values?.["p(95)"] ?? 0;
  const passed = p95 <= P95_THRESHOLD;

  console.log(`\n--- Event Indexer Load Test ---`);
  console.log(`P95 latency: ${p95.toFixed(2)}ms (threshold: ${P95_THRESHOLD}ms)`);
  console.log(`Result: ${passed ? "PASS" : "FAIL"}\n`);

  return {
    stdout: "",
    "load-tests/event-indexer-summary.json": JSON.stringify({
      p95,
      threshold: P95_THRESHOLD,
      passed,
      vus: 20,
      duration: "120s",
    }),
  };
}
