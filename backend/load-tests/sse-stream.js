import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const connectionErrors = new Counter("sse_connection_errors");

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const API_KEY = __ENV.API_KEY || "";

export const options = {
  vus: 100,
  duration: "60s",
};

export default function () {
  const url = `${BASE_URL}/api/v1/admin/indexer/stream`;
  const params = {
    headers: {
      "Content-Type": "text/event-stream",
      ...(API_KEY ? { "X-API-Key": API_KEY } : {}),
    },
    timeout: "120s",
  };

  const res = http.get(url, params);

  const ok = check(res, {
    "status is 200": (r) => r.status === 200,
    "content-type is event-stream": (r) =>
      r.headers["Content-Type"]?.includes("text/event-stream") ?? false,
  });

  if (!ok) {
    connectionErrors.add(1);
  }
}
