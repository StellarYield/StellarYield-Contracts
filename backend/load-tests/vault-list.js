import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

/*
 * Load test script for GET /api/v1/vaults endpoint baseline (#958).
 *
 * How to run:
 *   1. Ensure the StellarYield backend service is running locally or in target environment.
 *   2. Run the load test using k6:
 *      k6 run backend/load-tests/vault-list.js
 *   3. Optionally specify a custom base URL via environment variable:
 *      BASE_URL=http://localhost:8080 k6 run backend/load-tests/vault-list.js
 */

const errorRate = new Rate('error_rate');
const latencyP50 = new Trend('latency_p50');
const latencyP95 = new Trend('latency_p95');
const latencyP99 = new Trend('latency_p99');

export const options = {
  stages: [
    { duration: '60s', target: 50 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'],
    error_rate: ['rate<0.01'],
  },
};

export default function () {
  const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
  const res = http.get(`${baseUrl}/api/v1/vaults`);

  const success = check(res, {
    'status is 200': (r) => r.status === 200,
  });

  errorRate.add(!success);
  latencyP50.add(res.timings.duration);
  latencyP95.add(res.timings.duration);
  latencyP99.add(res.timings.duration);

  sleep(1);
}
