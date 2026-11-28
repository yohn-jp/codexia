#!/usr/bin/env bash
# Read the installed Full writer and PostgreSQL under the existing deployment lock.
set -euo pipefail

deny() { printf '%s\n' "$1" >&2; exit 1; }

[[ $# == 0 && "$(id -un)" == codexia && "${HOME:-}" == /* ]] ||
  deny 'Writer observation requires the canonical codexia SSH identity'
lock="$HOME/.local/state/codexia-deploy/host.lock"
[[ -f "$lock" && ! -L "$lock" && -d "$HOME/.local/share/containers/storage" ]] ||
  deny 'Writer observation requires the existing rootless runtime and deployment lock'
exec 9<"$lock"
flock --shared --nonblock 9 || deny 'A deployment or backup is holding the host lock'

node <<'NODE'
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { lstatSync, readFileSync } = require('node:fs');
const { hostname } = require('node:os');
const { join } = require('node:path');

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const imageRepository = process.env.CODEXIA_IMAGE_REPOSITORY ?? '';
const matchesImage = image => /^ghcr\.io\/[a-z0-9-]+\/codexia-backend$/.test(imageRepository) &&
  typeof image === 'string' && image.startsWith(imageRepository + '@') &&
  /^sha256:[a-f0-9]{64}$/.test(image.slice(imageRepository.length + 1));
const containerPattern = /^[a-f0-9]{64}$/;
const ownerPattern = /^[a-zA-Z0-9._@:/|+-]+$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const digest = (value) => `sha256:${hash(value)}`;
const command = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 15000,
}).trim();

function requireEvidence(condition) {
  if (!condition) throw new Error('Inconsistent local evidence');
}

function privateFile(path, mode) {
  const stat = lstatSync(path);
  requireEvidence(stat.isFile() && stat.uid === process.getuid());
  if (mode !== undefined) requireEvidence((stat.mode & 0o777) === mode);
  return readFileSync(path, 'utf8');
}

function field(contents, key, optional = false) {
  const lines = contents.split('\n').filter(line => line.startsWith(key));
  requireEvidence(lines.length === 1 || (optional && lines.length === 0));
  return lines.length ? lines[0].slice(key.length) : undefined;
}

function postgres(sql) {
  return command('podman', ['exec', 'codexia-db', 'sh', '-ec', `
    export PGPASSWORD="$(cat /run/secrets/admin-password)"
    export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000"
    exec psql -X -qAt -v ON_ERROR_STOP=1 -U codexia_admin -d codexia -c "$1"
  `, 'sh', sql]);
}

function systemd(property, unit) {
  return command('systemctl', ['--user', 'show', `--property=${property}`, '--value', unit]);
}

function observeWriter() {
  return command('podman', ['inspect', '--type', 'container', '--format',
    '{{.Id}} {{.State.Running}} {{.Image}} {{.ImageName}} {{.State.Health.Status}}', 'codexia-api']);
}

function requireVolume(container, name, destination) {
  const mounts = JSON.parse(command('podman', ['inspect', '--type', 'container', '--format', '{{json .Mounts}}', container]));
  const matching = mounts.filter(mount => mount.Destination === destination || mount.Destination.startsWith(destination + '/'));
  requireEvidence(matching.length === 1 && matching[0].Type === 'volume' && matching[0].Name === name &&
    matching[0].Destination === destination && matching[0].RW === true);
}

function requireOnlyWriter(containerId) {
  for (const filter of ['name=codexia-api', 'volume=codexia-history']) {
    requireEvidence(command('podman', ['ps', '--no-trunc', '--filter', filter, '--format', '{{.ID}}']) === containerId);
  }
}

function tunnelIsRunning() {
  try {
    command('podman', ['container', 'exists', 'codexia-tunnel']);
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
  const running = command('podman', ['inspect', '--type', 'container', '--format', '{{.State.Running}}', 'codexia-tunnel']);
  requireEvidence(['true', 'false'].includes(running));
  return running === 'true';
}

function ledgerFingerprint(ledger) {
  // Same wire identity as migrationSetFingerprint in persistence-postgres.
  requireEvidence(Array.isArray(ledger) && ledger.length > 0);
  const versions = new Set();
  for (const row of ledger) {
    requireEvidence(Array.isArray(row) && row.length === 2 &&
      typeof row[0] === 'string' && /^\d+[-\w]*\.sql$/.test(row[0]) &&
      typeof row[1] === 'string' && /^[a-f0-9]{64}$/.test(row[1]) && !versions.has(row[0]));
    versions.add(row[0]);
  }
  ledger.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return digest(JSON.stringify(ledger));
}

let stage = 'rootless runtime';
try {
  const host = hostname();
  const machineId = readFileSync('/etc/machine-id', 'utf8').trim();
  requireEvidence(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(host) && /^[a-f0-9]{32}$/.test(machineId));
  requireEvidence(command('podman', ['info', '--format', '{{.Host.Security.Rootless}}']) === 'true');

  stage = 'running Full writer identity';
  const firstWriter = observeWriter();
  const [containerId, running, imageId, image, health, ...rest] = firstWriter.split(' ');
  requireEvidence(rest.length === 0 && containerPattern.test(containerId) &&
    /^(?:sha256:)?[a-f0-9]{64}$/.test(imageId) && matchesImage(image) &&
    running === 'true' && health === 'healthy' && systemd('ActiveState', 'codexia-api.service') === 'active');
  requireOnlyWriter(containerId);
  requireVolume('codexia-api', 'codexia-data', '/data');
  requireVolume('codexia-api', 'codexia-history', '/history');
  const imageReferences = JSON.parse(command('podman', ['image', 'inspect', '--format', '{{json .RepoDigests}}', imageId]));
  requireEvidence(Array.isArray(imageReferences) && imageReferences.includes(image));
  const identity = JSON.parse(command('podman', ['exec', containerId, 'cat', '/app/update-identity.json']));
  requireEvidence(identity && Object.keys(identity).sort().join(',') ===
      'apiEpoch,format,migrationFingerprint,persistenceFormat,platform,profile,sourceSha,version' &&
    identity.format === 'codexia-backend-identity/v1' && identity.profile === 'full' && identity.platform === 'linux/amd64' &&
    typeof identity.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(identity.sourceSha) &&
    typeof identity.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(identity.version) &&
    typeof identity.migrationFingerprint === 'string' && digestPattern.test(identity.migrationFingerprint) &&
    Number.isSafeInteger(identity.apiEpoch) && identity.apiEpoch > 0 &&
    Number.isSafeInteger(identity.persistenceFormat) && identity.persistenceFormat > 0);

  stage = 'canonical Quadlet and protected settings';
  const unit = join(process.env.HOME, '.config/containers/systemd/codexia-api.container');
  requireEvidence(systemd('SourcePath', 'codexia-api.service') === unit);
  const quadlet = privateFile(unit);
  requireEvidence(field(quadlet, 'Image=') === image);
  const quadletSha256 = digest(quadlet);
  const configuredMode = field(quadlet, 'Environment=CODEXIA_AUTH_MODE=', true);
  let authMode = 'legacy';
  let settingsSha256 = null;
  let ownerBindingSha256 = null;
  if (configuredMode === 'better-auth') {
    authMode = 'better-auth';
    const settingsHash = field(quadlet, 'Environment=CODEXIA_AUTH_SETTINGS_SHA256=');
    requireEvidence(containerPattern.test(settingsHash));
    const settingsPath = join(process.env.HOME, '.config/codexia-auth', `runtime-${settingsHash}.env`);
    requireEvidence(field(quadlet, 'EnvironmentFile=') === settingsPath);
    const settings = privateFile(settingsPath, 0o600);
    settingsSha256 = digest(settings);
    requireEvidence(settingsSha256 === `sha256:${settingsHash}`);
    const owner = field(settings, 'CODEXIA_OAUTH_OWNER_SUBJECT=');
    requireEvidence(ownerPattern.test(owner));
    ownerBindingSha256 = digest(owner);
    const installedOwner = command('podman', ['exec', containerId, 'node', '-e', `
      const { createHash } = require('node:crypto');
      const subject = process.env.CODEXIA_OAUTH_OWNER_SUBJECT;
      if (!subject || process.env.CODEXIA_AUTH_MODE !== 'better-auth' ||
          process.env.CODEXIA_AUTH_SETTINGS_SHA256 !== process.argv[1] ||
          process.env.CODEXIA_DATABASE_HOST !== 'codexia-db' ||
          process.env.CODEXIA_DATABASE_NAME !== 'codexia' ||
          process.env.CODEXIA_DATABASE_USER !== 'codexia' ||
          process.env.CODEXIA_DATABASE_PASSWORD_FILE !== '/run/secrets/app-password' ||
          process.env.CODEXIA_DATABASE_URL) process.exit(1);
      let authDatabase;
      try {
        authDatabase = new URL(process.env.CODEXIA_AUTH_DATABASE_URL);
      } catch {
        process.exit(1);
      }
      if (!['postgres:', 'postgresql:'].includes(authDatabase.protocol) ||
          authDatabase.username !== 'codexia_auth_runtime' || !authDatabase.password ||
          authDatabase.hostname !== 'codexia-db' || authDatabase.port !== '5432' ||
          authDatabase.pathname !== '/codexia' || authDatabase.search || authDatabase.hash) process.exit(1);
      console.log('sha256:' + createHash('sha256').update(subject).digest('hex'));
    `, settingsHash]);
    requireEvidence(installedOwner === ownerBindingSha256);
  } else {
    requireEvidence(configuredMode === undefined || configuredMode === 'token');
  }

  stage = 'PostgreSQL cluster and migration ledger';
  requireEvidence(systemd('ActiveState', 'codexia-db.service') === 'active');
  requireVolume('codexia-db', 'codexia-postgres', '/var/lib/postgresql/data');
  const databaseEvidence = JSON.parse(postgres(`SELECT json_build_object(
    'clusterId', (SELECT system_identifier::text FROM pg_control_system()),
    'ledger', (SELECT json_agg(json_build_array(version, btrim(checksum))) FROM public.codexia_schema_migrations)
  )`));
  const { clusterId, ledger } = databaseEvidence;
  requireEvidence(typeof clusterId === 'string' && /^[1-9][0-9]{0,19}$/.test(clusterId));
  const migrationLedgerSha256 = ledgerFingerprint(ledger);
  requireEvidence(migrationLedgerSha256 === identity.migrationFingerprint);

  if (ownerBindingSha256) {
    stage = 'Better Auth owner binding';
    // Only a locally computed hexadecimal hash is interpolated. PostgreSQL returns a boolean.
    requireEvidence(postgres(`SELECT EXISTS (SELECT 1 FROM codexia_auth."user"
      WHERE encode(sha256(convert_to(id::text, 'UTF8')), 'hex') = '${ownerBindingSha256.slice(7)}')`) === 't');
  }

  stage = 'Tunnel state';
  const unitState = systemd('ActiveState', 'codexia-tunnel.service');
  requireEvidence(['active', 'inactive', 'failed'].includes(unitState));
  const containerRunning = tunnelIsRunning();
  requireEvidence((unitState === 'active') === containerRunning);

  stage = 'observation consistency';
  requireOnlyWriter(containerId);
  requireEvidence(observeWriter() === firstWriter && digest(privateFile(unit)) === quadletSha256 &&
    systemd('ActiveState', 'codexia-tunnel.service') === unitState && tunnelIsRunning() === containerRunning);
  console.log(JSON.stringify({
    format: 'codexia-writer-observation/v1',
    observedAt: new Date().toISOString(),
    host,
    hostId: hash(machineId),
    writer: { containerId, image, identity, authMode, quadletSha256, settingsSha256, ownerBindingSha256 },
    database: { clusterId, migrationLedgerSha256 },
    tunnel: { unitState, containerRunning },
  }));
} catch {
  console.error(`Writer observation failed: ${stage}`);
  process.exitCode = 1;
}
NODE
