import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const backendLatency = new Trend('backend_latency', true);
const frontendLatency = new Trend('frontend_latency', true);

const FRONTEND_URL = __ENV.FRONTEND_URL || 'http://app.yourdomain.com';
const BACKEND_URL = __ENV.BACKEND_URL || 'http://api.yourdomain.com';

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 2,
      duration: '30s',
      tags: { scenario: 'smoke' },
    },
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 10 },   // ramp up
        { duration: '3m', target: 10 },   // hold — matches canary pause duration
        { duration: '1m', target: 20 },   // ramp to next canary weight
        { duration: '3m', target: 20 },   // hold
        { duration: '1m', target: 0 },    // ramp down
      ],
      startTime: '30s', // after smoke
      tags: { scenario: 'load' },
    },
  },
  thresholds: {
    // Keep error rate under 1%
    errors: ['rate<0.01'],
    // 95th percentile under 500ms for both services
    backend_latency: ['p(95)<500'],
    frontend_latency: ['p(95)<500'],
    // Overall http thresholds
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<500'],
  },
};

export default function () {
  // Frontend
  const frontendRes = http.get(FRONTEND_URL, { tags: { service: 'frontend' } });
  frontendLatency.add(frontendRes.timings.duration);
  const frontendOk = check(frontendRes, {
    'frontend status 200': (r) => r.status === 200,
    'frontend response time < 500ms': (r) => r.timings.duration < 500,
  });
  errorRate.add(!frontendOk);

  sleep(1);

  // Backend health
  const backendRes = http.get(`${BACKEND_URL}/health`, { tags: { service: 'backend' } });
  backendLatency.add(backendRes.timings.duration);
  const backendOk = check(backendRes, {
    'backend status 200': (r) => r.status === 200,
    'backend response time < 500ms': (r) => r.timings.duration < 500,
  });
  errorRate.add(!backendOk);

  sleep(1);
}
