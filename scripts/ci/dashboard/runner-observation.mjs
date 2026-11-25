// Observational browser-runner telemetry; never certification or release evidence.
import { availableParallelism, cpus, freemem, loadavg, release, totalmem } from 'node:os';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const paths = {
  cpuMax: '/sys/fs/cgroup/cpu.max',
  cpuStat: '/sys/fs/cgroup/cpu.stat',
  memoryMax: '/sys/fs/cgroup/memory.max',
  memoryCurrent: '/sys/fs/cgroup/memory.current',
  memoryEvents: '/sys/fs/cgroup/memory.events',
  cpuPressure: '/sys/fs/cgroup/cpu.pressure',
  ioPressure: '/sys/fs/cgroup/io.pressure',
  memoryPressure: '/sys/fs/cgroup/memory.pressure',
};

function readMetric(read, file) {
  try {
    const result = read(file, 'utf8').trim();
    return result.length <= 4096 ? result : null;
  } catch {
    return null;
  }
}

export function collectRunnerObservation(phase, { read = readFileSync, env = process.env, now = () => new Date() } = {}) {
  if (!['before', 'after'].includes(phase)) throw new Error('Invalid runner observation phase');
  return {
    schema: 'codexia-browser-runner-observation/v1',
    phase,
    observedAt: now().toISOString(),
    sourceSha: env.CODEXIA_EXPECTED_SHA ?? null,
    runId: env.GITHUB_RUN_ID ?? null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    group: env.CODEXIA_CI_BROWSER_GROUP ?? null,
    imageDigest: env.CODEXIA_PLAYWRIGHT_IMAGE_DIGEST ?? null,
    imageOS: env.ImageOS ?? null,
    imageVersion: env.ImageVersion ?? null,
    runner: { platform: process.platform, arch: process.arch, kernel: release(),
      node: process.version, cpuModel: cpus()[0]?.model ?? null, reportedLogicalCpus: cpus().length,
      availableParallelism: availableParallelism(), totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(),
      loadAverage: loadavg() },
    cgroup: Object.fromEntries(Object.entries(paths).map(([name, file]) => [name, readMetric(read, file)])),
    caveat: 'Container-visible metrics are not host utilization or a causal diagnosis. Provider/region is not supplied by the Actions environment; consult the job provisioner log.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, output, ...extra] = process.argv.slice(2);
  if (!output || extra.length) throw new Error('Usage: runner-observation.mjs before|after output-directory');
  const observation = collectRunnerObservation(phase);
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, phase + '.json'), JSON.stringify(observation, null, 2) + '\n');
  console.log('RUNNER_OBSERVATION ' + JSON.stringify(observation));
}
