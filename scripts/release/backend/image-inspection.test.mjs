import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertBackendImageIdentity } from './image-inspection.mjs';
import { verifyBuiltBackendImageIdentity } from './verify-image-identity.mjs';

test('static backend image identity binds producer, profile, platform and compatibility',()=>{
  const sourceSha='a'.repeat(40),version='0.1.90',fingerprint='sha256:'+'b'.repeat(64),image='ghcr.io/yohn-jp/codexia-backend@sha256:'+'c'.repeat(64);
  const identity={format:'codexia-backend-identity/v1',version,sourceSha,profile:'core',platform:'linux/amd64',migrationFingerprint:fingerprint,apiEpoch:1,persistenceFormat:1};
  const observed={Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':sourceSha}},RepoDigests:[image]};
  assert.deepEqual(assertBackendImageIdentity(identity,observed,{image,sourceSha,version,profile:'core',migrationFingerprint:fingerprint,
    compatibility:{apiEpoch:1,persistenceFormat:1}}),identity);
  for(const patch of [{sourceSha:'d'.repeat(40)},{version:'0.1.91'},{profile:'full'},{migrationFingerprint:'sha256:'+'e'.repeat(64)}])
    assert.throws(()=>assertBackendImageIdentity(identity,observed,{sourceSha,version,profile:'core',migrationFingerprint:fingerprint,compatibility:{apiEpoch:1,persistenceFormat:1},...patch}));
  assert.throws(()=>assertBackendImageIdentity(identity,{...observed,Config:{Labels:{'org.opencontainers.image.revision':'d'.repeat(40)}}},{sourceSha,version,profile:'core'}));
});

test('inspects the image without running it and discards the container even when its identity is missing', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'codexia-image-inspection-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, 'scratch');
  await mkdir(scratch);

  const sourceSha = 'a'.repeat(40);
  const identity = {
    format: 'codexia-backend-identity/v1',
    version: '1.2.3',
    sourceSha,
    profile: 'full',
    platform: 'linux/amd64',
    migrationFingerprint: 'sha256:' + 'b'.repeat(64),
    apiEpoch: 1,
    persistenceFormat: 1,
  };
  const image = 'example.invalid/test-image:fixture';
  const docker = path.join(root, 'docker');
  await writeFile(docker, `#!${process.execPath}
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, command + '\\n');
switch (command) {
  case 'image':
    if (args[0] !== 'inspect' || args[1] !== process.env.IMAGE) process.exit(2);
    console.log(JSON.stringify([{
      Os: 'linux',
      Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': process.env.SOURCE_SHA } },
    }]));
    break;
  case 'create':
    if (args.at(-1) !== process.env.IMAGE) process.exit(2);
    fs.writeFileSync(process.env.CONTAINER, '');
    console.log('fixture-container');
    break;
  case 'cp':
    if (args[0] !== 'fixture-container:/app/update-identity.json' || !fs.existsSync(process.env.CONTAINER)) {
      process.exit(2);
    }
    if (process.env.MISSING_IDENTITY) process.exit(1);
    fs.writeFileSync(args[1], process.env.IDENTITY);
    break;
  case 'rm':
    if (!args.includes('fixture-container') || !args.includes('--volumes')) process.exit(2);
    fs.unlinkSync(process.env.CONTAINER);
    break;
  default:
    process.exit(2);
}
`);
  await chmod(docker, 0o755);

  const module = new URL('./image-inspection.mjs', import.meta.url);
  const invoke = async (name, missingIdentity) => {
    const log = path.join(root, name + '.log');
    const container = path.join(root, name + '.container');
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { inspectBackendImageWithoutExecution } from ${JSON.stringify(module.href)};
      try {
        const identity = await inspectBackendImageWithoutExecution(process.env.IMAGE, {
          sourceSha: process.env.SOURCE_SHA,
          profile: 'full',
        }, { tempRoot: process.env.SCRATCH });
        console.log(JSON.stringify({ identity }));
      } catch {
        console.log(JSON.stringify({ rejected: true }));
      }
    `], {
      encoding: 'utf8',
      env: {
        PATH: root,
        IMAGE: image,
        SOURCE_SHA: sourceSha,
        SCRATCH: scratch,
        IDENTITY: JSON.stringify(identity),
        COMMAND_LOG: log,
        CONTAINER: container,
        ...(missingIdentity && { MISSING_IDENTITY: '1' }),
      },
    });
    assert.doesNotMatch(await readFile(log, 'utf8'), /^(?:run|start|exec)$/mu);
    await assert.rejects(readFile(container), { code: 'ENOENT' });
    assert.deepEqual(await readdir(scratch), []);
    return JSON.parse(result);
  };

  assert.deepEqual(await invoke('present', false), { identity });
  assert.deepEqual(await invoke('missing', true), { rejected: true });
});

test('built-image identity CLI rejects malformed producer data before Docker inspection',async()=>{
  await assert.rejects(()=>verifyBuiltBackendImageIdentity({args:['image','a'.repeat(40),'bad','core']}),/version is invalid/);
  await assert.rejects(()=>verifyBuiltBackendImageIdentity({args:['image','bad','0.1.1','core']}),/source SHA is invalid/);
});
