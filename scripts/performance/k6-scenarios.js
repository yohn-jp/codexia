import { check, fail, sleep } from 'k6';
import crypto from 'k6/crypto';
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { fixtureOrigin } from './k6-target.mjs';

const origin = fixtureOrigin(__ENV.CODEXIA_K6_ORIGIN);
const token = __ENV.CODEXIA_K6_TOKEN;
const sceneSha256 = __ENV.CODEXIA_K6_SCENE_SHA256;
if (!/^[a-f0-9]{48}$/.test(token) || !/^[a-f0-9]{64}$/.test(sceneSha256)) {
  throw new Error('Missing synthetic fixture identity');
}
const profiles = {
  smoke: { executor: 'shared-iterations', vus: 1, iterations: 2, maxDuration: '20s' },
  measurement: { executor: 'constant-vus', vus: 2, duration: '30s', gracefulStop: '5s' },
};
const scenario = profiles[__ENV.CODEXIA_K6_PROFILE];
if (!Object.hasOwn(profiles, __ENV.CODEXIA_K6_PROFILE)) throw new Error('Unknown synthetic workload profile');
const sceneMs = new Trend('fixture_scene_ms', true);
const scenePgMs = new Trend('fixture_scene_pg_round_trip_ms', true);
const streamMs = new Trend('fixture_stream_ms', true);
const streamFirstByteMs = new Trend('fixture_stream_first_byte_ms', true);
export const options = {
  scenarios: { synthetic: scenario },
  setupTimeout: '5s',
  summaryTrendStats: ['count', 'min', 'p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    checks: ['rate==1'],
    iterations: [__ENV.CODEXIA_K6_PROFILE === 'smoke' ? 'count==2' : 'count>0'],
  },
};

function get(path, name) {
  return http.get(origin + path, {
    redirects: 0,
    timeout: '4s',
    headers: { 'X-Codexia-Fixture': token },
    tags: { name },
  });
}

export function setup() {
  const ready = get('/ready', 'fixture_ready');
  if (ready.status !== 204 || ready.headers['X-Codexia-Fixture'] !== token) {
    fail('Target did not identify itself as this synthetic fixture');
  }
}

export default function () {
  const scene = get('/scene', 'fixture_scene');
  const timing = /^pg;dur=(\d+\.\d+)$/.exec(scene.headers['Server-Timing'] ?? '');
  if (check(scene, {
    'synthetic scene body matches': r => r.status === 200 && crypto.sha256(r.body, 'hex') === sceneSha256,
    'PostgreSQL round trip recorded': () => timing !== null,
  })) {
    sceneMs.add(scene.timings.duration);
    scenePgMs.add(Number(timing[1]));
  }

  const stream = get('/stream', 'fixture_stream');
  if (check(stream, {
    'finite event stream completes': r => r.status === 200 &&
      r.headers['Content-Type'] === 'text/event-stream' && r.body === 'data: ready\n\ndata: complete\n\n',
  })) {
    streamMs.add(stream.timings.duration);
    streamFirstByteMs.add(stream.timings.waiting);
  }
  if (__ENV.CODEXIA_K6_PROFILE === 'measurement') sleep(0.1);
}
