#!/usr/bin/env node
// Run Impeccable against app source and authenticated, inert visual snapshots.
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.join(root, 'artifacts', 'ui-preview');
const version = '4.10.0';

export function checkedSnapshotUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('Snapshot server must use a loopback HTTP origin with no credentials or path');
  }
  return parsed.origin;
}

async function detector(args) {
  const win = process.platform === 'win32';
  return new Promise((resolve, reject) => {
    let stdout = '';
    const child = spawn('npx', ['--yes', `impeccable@${version}`, 'detect', ...args], {
      cwd: root,
      shell: win,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.once('error', reject);
    child.once('close', code => code === 0 || code === 2
      ? resolve({ findings: JSON.parse(stdout), exitCode: code })
      : reject(new Error(`Impeccable could not scan target (exit ${code}). Do not treat empty output as a clean scan.`)));
  });
}

async function main() {
  const session = JSON.parse(await readFile(path.join(outputDir, 'session.json'), 'utf8'));
  const origin = checkedSnapshotUrl(session.snapshotBaseURL);
  const health = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok || (await health.json()).id !== session.id) throw new Error('Preview session is stale or not running');
  const directory = path.join(outputDir, 'detector');
  await mkdir(directory, { recursive: true });
  const scans = [
    { name: 'source', args: ['--json', 'app'] },
    { name: 'desktop', args: ['--no-design-system', '--viewport', '1440x900', '--json', `${origin}/desktop/`] },
    { name: 'mobile', args: ['--no-design-system', '--viewport', '390x844', '--json', `${origin}/mobile/`] },
  ];
  const report = { tool: `impeccable@${version}`, snapshot: true, scans: {} };
  for (const scan of scans) {
    console.log(`Checking ${scan.name}...`);
    const result = await detector(scan.args);
    if (!Array.isArray(result.findings)) throw new Error(`Unexpected JSON shape for ${scan.name}`);
    await writeFile(path.join(directory, `${scan.name}.json`), JSON.stringify(result.findings, null, 2) + '\n');
    report.scans[scan.name] = {
      findings: result.findings.length,
      primary: result.findings.filter(item => !item.advisory).length,
      advisories: result.findings.filter(item => item.advisory).length,
      detectorExitCode: result.exitCode,
    };
  }
  await writeFile(path.join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Reports saved in ${path.relative(root, directory)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`UI scan failed: ${error?.message ?? error}`); process.exitCode = 1; });
}
