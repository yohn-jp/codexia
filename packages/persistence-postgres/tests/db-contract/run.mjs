#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { authSchemaFingerprint, CODEXIA_AUTH_SCHEMA, verifyAuthSchema } from '../../../../packages/api/dist/auth-schema.js';
import { migrateBetterAuth, readBetterAuthMigrationConfig } from '../../../../packages/api/dist/migrate-auth.js';
import { assertCatalogMatches, buildSourceIdentity, parseTapOutput } from '../../../../scripts/postgres-contract/contract-runner.mjs';
import { initializeFreshPostgresSchema, packagedMigrationFingerprint, verifyPostgresSchema } from '../../dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageRoot = path.join(root, 'packages/persistence-postgres');
const contractDirectory = path.join(packageRoot, 'tests/db-contract');
const toolchain = JSON.parse(await readFile(path.join(contractDirectory, 'toolchain.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('hex');
const pgImage = toolchain.postgresImage;
const contractImage = `codexia-pgtap-contract:${digest(JSON.stringify(toolchain)).slice(0, 16)}`;
const updateContract = process.argv.slice(2).includes('--update-catalog-contract');
if (process.argv.slice(2).some(arg => arg !== '--update-catalog-contract')) throw new Error('Unknown database contract runner option');

function invoke(command, args, { input, env = process.env, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { cwd: root, input, env, encoding: null, maxBuffer });
  if (result.error) throw new Error(`${path.basename(command)} could not start`);
  if (result.status !== 0) {
    let diagnostic =
      `${(result.stderr ?? Buffer.alloc(0)).toString('utf8')}\n${(result.stdout ?? Buffer.alloc(0)).toString('utf8')}`.trim();
    for (const argument of args)
      if (/^postgres:\/\//u.test(String(argument))) diagnostic = diagnostic.replaceAll(String(argument), '<disposable-database-url>');
    throw new Error(
      `${path.basename(command)} failed with status ${result.status ?? result.signal}${diagnostic ? `: ${diagnostic.slice(-1200)}` : ''}`,
    );
  }
  return result.stdout ?? Buffer.alloc(0);
}

function output(command, args, options) {
  return invoke(command, args, options).toString('utf8').trim();
}

function url({ port, database, user, password }) {
  const credential =
    password === undefined ? `${encodeURIComponent(user)}@` : `${encodeURIComponent(user)}:${encodeURIComponent(password)}@`;
  return `postgres://${credential}127.0.0.1:${port}/${database}`;
}

const literal = value => `'${String(value).replaceAll("'", "''")}'`;

async function waitForDatabase(pool, label) {
  let lastCode = 'unknown';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastCode = error.code ?? 'unknown';
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${label} did not become ready (${lastCode})`);
}

async function sourceIdentity() {
  const sourceSha = output('git', ['rev-parse', 'HEAD']);
  const paths = [
    'docs/architecture/POSTGRES-CONTRACT-VERIFICATION.md',
    'docs/architecture/DATABASE-DETAIL-CONTRACT.md',
    'docs/architecture/DATA-MODEL.md',
    'docs/requirements/REQUIREMENT-REGISTER.md',
    'docs/verification/SPECIFICATION-TOOLING-ACCEPTANCE.md',
    'deploy/ansible/verify-postgres-roles.sql',
    'deploy/backup/backup.sh',
    'packages/api/package.json',
    'packages/api/src/auth-schema.ts',
    'packages/api/src/migrate-auth.ts',
    'packages/persistence-postgres/package.json',
    'packages/persistence-postgres/src/migrate.ts',
    'packages/persistence-postgres/src/migration-set.ts',
    'packages/persistence-postgres/tests/db-contract/Dockerfile',
    'packages/persistence-postgres/tests/db-contract/application-contract.sql',
    'packages/persistence-postgres/tests/db-contract/catalog-contract.json',
    'packages/persistence-postgres/tests/db-contract/restore-proof-auth.sql',
    'packages/persistence-postgres/tests/db-contract/restore-proof-identity.sql',
    'packages/persistence-postgres/tests/db-contract/restore-proof.sh',
    'packages/persistence-postgres/tests/db-contract/run.mjs',
    'packages/persistence-postgres/tests/db-contract/toolchain.json',
    'scripts/postgres-contract/contract-runner.mjs',
    'pnpm-lock.yaml',
  ];
  const migrations = await readdir(path.join(packageRoot, 'migrations'));
  paths.push(...migrations.filter(name => /^\d+[-\w]*\.sql$/u.test(name)).map(name => `packages/persistence-postgres/migrations/${name}`));
  return buildSourceIdentity({
    sourceSha,
    files: await Promise.all(paths.map(async file => ({ path: file, contents: await readFile(path.join(root, file)) }))),
  });
}

async function catalog(pool) {
  const schemas = ['public', CODEXIA_AUTH_SCHEMA];
  const q = async sql => (await pool.query(sql, [schemas])).rows;
  const result = {
    schemas: await q(`SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable) ORDER BY a.grantee,a.privilege_type,a.is_grantable)
        FROM aclexplode(COALESCE(n.nspacl,acldefault('n'::"char",n.nspowner))) a),'[]'::jsonb) AS grants
      FROM pg_namespace n WHERE n.nspname=ANY($1) ORDER BY n.nspname`),
    relations: await q(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,
        c.relpersistence AS persistence,pg_get_userbyid(c.relowner) AS owner,
        c.relrowsecurity AS row_security,c.relforcerowsecurity AS force_row_security,
        c.relreplident AS replica_identity,COALESCE(c.reloptions,ARRAY[]::text[]) AS options
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1) AND c.relkind IN ('r','p','v','m','S','f')
      ORDER BY n.nspname,c.relname,c.relkind`),
    columns: await q(`SELECT n.nspname AS schema,c.relname AS relation,a.attnum AS ordinal,a.attname AS name,
        format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
        a.attidentity AS identity,a.attgenerated AS generated,
        CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END AS collation,
        pg_get_expr(d.adbin,d.adrelid) AS default_expression
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','S','f')
      ORDER BY n.nspname,c.relname,a.attnum`),
    constraints: await q(`SELECT n.nspname AS schema,c.relname AS relation,k.conname AS name,k.contype AS kind,
        k.condeferrable AS deferrable,k.condeferred AS initially_deferred,k.convalidated AS validated,
        pg_get_constraintdef(k.oid,false) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1) ORDER BY n.nspname,c.relname,k.conname`),
    indexes: await q(`SELECT n.nspname AS schema,c.relname AS relation,i.relname AS name,
        x.indisunique AS unique,x.indisprimary AS primary,x.indisexclusion AS exclusion,
        x.indisvalid AS valid,x.indisready AS ready,pg_get_indexdef(i.oid) AS definition
      FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=ANY($1) ORDER BY n.nspname,c.relname,i.relname`),
    triggers: await q(`SELECT n.nspname AS schema,c.relname AS relation,t.tgname AS name,
        t.tgenabled AS enabled,t.tgisinternal AS internal,p.proname AS function,
        pg_get_triggerdef(t.oid,false) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=ANY($1)
      ORDER BY n.nspname,c.relname,t.tgname`),
    functions: await q(`SELECT n.nspname AS schema,p.proname AS name,p.prokind AS kind,
        pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_function_result(p.oid) AS result,
        l.lanname AS language,p.provolatile AS volatility,p.proisstrict AS strict,p.prosecdef AS security_definer,
        COALESCE(p.proconfig,ARRAY[]::text[]) AS configuration,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
      WHERE n.nspname=ANY($1) ORDER BY n.nspname,p.proname,arguments`),
    types: await q(`SELECT n.nspname AS schema,t.typname AS name,t.typtype AS kind,
        format_type(t.oid,NULL) AS type,t.typnotnull AS not_null,pg_get_userbyid(t.typowner) AS owner,
        COALESCE((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid),'[]'::jsonb) AS enum_values
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname=ANY($1) AND t.typtype<>'p' ORDER BY n.nspname,t.typname`),
    tableGrants: await q(`SELECT n.nspname AS schema,c.relname AS relation,c.relkind AS kind,
        pg_get_userbyid(a.grantor) AS grantor,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
        a.privilege_type AS privilege,a.is_grantable AS grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault((CASE WHEN c.relkind='S' THEN 's' ELSE 'r' END)::"char",c.relowner))) a
      WHERE n.nspname=ANY($1) AND c.relkind IN ('r','p','v','m','S','f')
      ORDER BY n.nspname,c.relname,grantee,privilege,grantable`),
    columnGrants: await q(`SELECT n.nspname AS schema,c.relname AS relation,a.attname AS column,
        CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END AS grantee,
        g.privilege_type AS privilege,g.is_grantable AS grantable
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(a.attacl) g
      WHERE n.nspname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY n.nspname,c.relname,a.attnum,grantee,privilege`),
    routineGrants: await q(`SELECT n.nspname AS schema,p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,
        CASE WHEN g.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END AS grantee,
        g.privilege_type AS privilege,g.is_grantable AS grantable
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f'::"char",p.proowner))) g
      WHERE n.nspname=ANY($1) ORDER BY n.nspname,p.proname,arguments,grantee,privilege`),
    databaseGrants: (
      await pool.query(`SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
        a.privilege_type AS privilege,a.is_grantable AS grantable
      FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d'::"char",d.datdba))) a
      WHERE d.datname=current_database() ORDER BY grantee,privilege,grantable`)
    ).rows,
    defaultPrivileges: await q(`SELECT pg_get_userbyid(d.defaclrole) AS owner,COALESCE(n.nspname,'') AS schema,
        d.defaclobjtype AS object_type,CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
        a.privilege_type AS privilege,a.is_grantable AS grantable
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace=0 OR n.nspname=ANY($1)
      ORDER BY owner,schema,object_type,grantee,privilege,grantable`),
    roles: (
      await pool.query(`SELECT rolname AS name,rolsuper AS superuser,rolinherit AS inherit,
        rolcreaterole AS create_role,rolcreatedb AS create_database,rolcanlogin AS can_login,
        rolreplication AS replication,rolbypassrls AS bypass_rls
      FROM pg_roles WHERE rolname IN ('postgres','codexia','codexia_admin','codexia_auth_runtime') ORDER BY rolname`)
    ).rows,
    roleMemberships: (
      await pool.query(`SELECT parent.rolname AS role,member.rolname AS member,
        m.admin_option AS admin_option,m.inherit_option AS inherit_option,m.set_option AS set_option
      FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
      WHERE parent.rolname LIKE 'codexia%' OR member.rolname LIKE 'codexia%'
      ORDER BY parent.rolname,member.rolname`)
    ).rows,
    extensions: await q(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname=ANY($1) ORDER BY e.extname`),
    migrationLedger: (await pool.query('SELECT version,btrim(checksum) AS checksum FROM public.codexia_schema_migrations ORDER BY version'))
      .rows,
  };
  return result;
}

async function download(entry, directory, name) {
  const destination = path.join(directory, name);
  invoke('curl', ['--fail', '--silent', '--show-error', '--location', entry.url, '--output', destination]);
  if (digest(await readFile(destination)) !== entry.sha256) throw new Error(`${name} failed its pinned SHA-256 check`);
  return destination;
}

async function listFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Generated artifact contains an unexpected symlink: ${relative}`);
    if (entry.isDirectory()) result.push(...(await listFiles(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort((left, right) => left.localeCompare(right, 'en'));
}

async function encryptStream(command, args, agePath, recipient, destination, label) {
  const producer = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const encryptor = spawn(agePath, ['-r', recipient, '-o', destination], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'] });
  const producerErrors = [];
  const encryptorErrors = [];
  producer.stderr.on('data', chunk => producerErrors.push(chunk));
  encryptor.stderr.on('data', chunk => encryptorErrors.push(chunk));
  producer.stdout.pipe(encryptor.stdin);
  const [sourceResult, encryptionResult] = await Promise.all([once(producer, 'close'), once(encryptor, 'close')]);
  if (sourceResult[0] !== 0 || encryptionResult[0] !== 0) {
    const sourceMessage = Buffer.concat(producerErrors).toString('utf8').trim().slice(-400);
    const encryptionMessage = Buffer.concat(encryptorErrors).toString('utf8').trim().slice(-400);
    throw new Error(
      `${label} stream failed (source=${sourceResult[0]}, age=${encryptionResult[0]}; ${sourceMessage}; ${encryptionMessage})`,
    );
  }
}

async function seedRestoreIdentity(applicationPool, authPool) {
  const identity = {
    ownerId: 'codexia-655-synthetic-owner',
    ownerEmail: 'codexia-655-synthetic-owner@example.invalid',
    projectId: '77777777-7777-4777-8777-777777777777',
    documentId: '88888888-8888-4888-8888-888888888888',
    revisionId: '99999999-9999-4999-8999-999999999999',
    projectTitle: 'DBV-007 synthetic manuscript',
    documentTitle: 'DBV-007 original manuscript',
    manuscript: '# DBV-007 synthetic manuscript\n\nOriginal revision for isolated restore verification.\n',
  };
  await applicationPool.query('INSERT INTO public.project(id,title) VALUES($1,$2)', [identity.projectId, identity.projectTitle]);
  await applicationPool.query(
    `INSERT INTO public.document(project_id,id,kind,title,order_key)
    VALUES($1,$2,'chapter',$3,'0001')`,
    [identity.projectId, identity.documentId, identity.documentTitle],
  );
  await applicationPool.query(
    `INSERT INTO public.document_revision(project_id,document_id,id,markdown,sha256,author_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [identity.projectId, identity.documentId, identity.revisionId, identity.manuscript, digest(identity.manuscript), identity.ownerId],
  );
  await applicationPool.query('UPDATE public.document SET head_revision_id=$3 WHERE project_id=$1 AND id=$2', [
    identity.projectId,
    identity.documentId,
    identity.revisionId,
  ]);
  await authPool.query(
    `INSERT INTO codexia_auth."user"("id","name","email","emailVerified","createdAt","updatedAt")
    VALUES($1,'Synthetic Codexia Owner',$2,true,clock_timestamp(),clock_timestamp())`,
    [identity.ownerId, identity.ownerEmail],
  );
  return identity;
}

async function verifyRestoreIdentity(pool, identity) {
  const result = await pool.query(
    `SELECT p.title AS project_title,d.id::text AS document_id,d.title AS document_title,
      d.head_revision_id::text AS head_revision_id,r.id::text AS revision_id,r.markdown AS revision_markdown,
      r.author_id,u.id AS owner_id,u.email AS owner_email
    FROM public.project p JOIN public.document d ON d.project_id=p.id
    JOIN public.document_revision r ON r.project_id=d.project_id AND r.document_id=d.id AND r.id=d.head_revision_id
    JOIN codexia_auth."user" u ON u.id=r.author_id WHERE p.id=$1 AND d.id=$2`,
    [identity.projectId, identity.documentId],
  );
  const row = result.rows[0];
  assert.deepEqual(row && { ...row }, {
    project_title: identity.projectTitle,
    document_id: identity.documentId,
    document_title: identity.documentTitle,
    head_revision_id: identity.revisionId,
    revision_id: identity.revisionId,
    revision_markdown: identity.manuscript,
    author_id: identity.ownerId,
    owner_id: identity.ownerId,
    owner_email: identity.ownerEmail,
  });
}

async function assertDriftDetected({ adminPool, port, postgresPassword, applicationPassword, expected }) {
  const sourceUrl = db => url({ port, database: db, user: 'postgres', password: postgresPassword });
  const verifyAlteredCatalog = async () => {
    const name = `codexia_catalog_drift_${randomBytes(3).toString('hex')}`;
    await adminPool.query(`CREATE DATABASE ${name} WITH TEMPLATE codexia OWNER codexia`);
    const pool = new Pool({ connectionString: sourceUrl(name) });
    try {
      await pool.query('ALTER TABLE public.project ADD COLUMN unreviewed_contract_drift text');
      const changed = await catalog(pool);
      assert.throws(() => assertCatalogMatches(expected, changed), /pg_catalog differs/u);
    } finally {
      await pool.end();
      await adminPool.query(`DROP DATABASE ${name}`);
    }
  };
  const verifyLedger = async () => {
    const name = `codexia_ledger_drift_${randomBytes(3).toString('hex')}`;
    await adminPool.query(`CREATE DATABASE ${name} WITH TEMPLATE codexia OWNER codexia`);
    const pool = new Pool({ connectionString: sourceUrl(name) });
    try {
      await pool.query(`UPDATE public.codexia_schema_migrations SET checksum=repeat('f',64)
        WHERE version=(SELECT min(version) FROM public.codexia_schema_migrations)`);
      await assert.rejects(
        verifyPostgresSchema(url({ port, database: name, user: 'codexia', password: applicationPassword })),
        /has changed/u,
      );
      const before = await pool.query(`SELECT count(*)::integer AS tables FROM pg_catalog.pg_class
        WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')`);
      await assert.rejects(
        initializeFreshPostgresSchema(url({ port, database: name, user: 'codexia', password: applicationPassword })),
        /has changed/u,
      );
      const after = await pool.query(`SELECT count(*)::integer AS tables FROM pg_catalog.pg_class
        WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')`);
      assert.deepEqual(after.rows, before.rows, 'migration identity failure must not apply or remove schema objects');
    } finally {
      await pool.end();
      await adminPool.query(`DROP DATABASE ${name}`);
    }
  };
  const verifyAuth = async () => {
    const name = `codexia_auth_drift_${randomBytes(3).toString('hex')}`;
    await adminPool.query(`CREATE DATABASE ${name} WITH TEMPLATE codexia OWNER codexia`);
    const pool = new Pool({ connectionString: sourceUrl(name) });
    try {
      await pool.query('ALTER TABLE codexia_auth."user" ADD COLUMN unreviewed_contract_drift text');
      await assert.rejects(verifyAuthSchema(pool), /schema requires explicit maintenance/u);
    } finally {
      await pool.end();
      await adminPool.query(`DROP DATABASE ${name}`);
    }
  };
  await verifyAlteredCatalog();
  await verifyLedger();
  await verifyAuth();
  return { catalogDriftRejected: true, migrationLedgerDriftRejected: true, authSchemaDriftRejected: true };
}

async function createPgtapDatabase({ adminPool, containerName, port, password }) {
  await adminPool.query('CREATE DATABASE codexia_contract WITH TEMPLATE codexia OWNER codexia');
  const pool = new Pool({ connectionString: url({ port, database: 'codexia_contract', user: 'postgres', password }) });
  try {
    await waitForDatabase(pool, 'pgTAP contract database');
    await pool.query('CREATE SCHEMA pgtap; CREATE EXTENSION pgtap WITH SCHEMA pgtap');
    const version = await pool.query("SELECT extversion FROM pg_extension WHERE extname='pgtap'");
    assert.equal(version.rows[0]?.extversion, toolchain.pgtap.version);
  } finally {
    await pool.end();
  }
  const sql = await readFile(path.join(contractDirectory, 'application-contract.sql'));
  const result = invoke(
    'docker',
    ['exec', '-i', containerName, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'codexia_contract'],
    { input: sql },
  );
  return parseTapOutput(result.toString('utf8'));
}

async function prepareTblsReader({ adminPool, port, postgresPassword }) {
  const role = 'codexia_contract_reader';
  const readerPassword = secret();
  await adminPool.query(
    `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(readerPassword)}`,
  );
  await adminPool.query(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
  await adminPool.query(`GRANT CONNECT ON DATABASE codexia TO ${role}`);
  const grantPool = new Pool({ connectionString: url({ port, database: 'codexia', user: 'postgres', password: postgresPassword }) });
  try {
    await grantPool.query(`GRANT USAGE ON SCHEMA public, codexia_auth TO ${role}`);
    await grantPool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public, codexia_auth TO ${role}`);
  } finally {
    await grantPool.end();
  }
  const readerUrl = url({ port, database: 'codexia', user: role, password: readerPassword });
  const readerPool = new Pool({ connectionString: readerUrl });
  try {
    const setting = await readerPool.query('SHOW default_transaction_read_only');
    assert.equal(setting.rows[0]?.default_transaction_read_only, 'on');
    await assert.rejects(readerPool.query('CREATE TABLE public.tbls_write_probe (id integer)'), /read-only transaction/u);
  } finally {
    await readerPool.end();
  }
  return readerUrl;
}

async function verifyEncryptedRestore({
  tempDirectory,
  evidenceDirectory,
  agePath,
  sourceContainer,
  identity,
  expectedLedger,
  expectedAuthFingerprint,
}) {
  const backup = path.join(evidenceDirectory, 'encrypted-backup-v2');
  const proof = path.join(evidenceDirectory, 'restore-proof');
  await mkdir(backup);
  await mkdir(proof);
  const ageDirectory = path.dirname(agePath);
  const ageKeygen = path.join(ageDirectory, 'age-keygen');
  const keyFile = path.join(tempDirectory, 'recovery-identity.txt');
  invoke(ageKeygen, ['-o', keyFile]);
  await chmod(keyFile, 0o400);
  const recipient = output(ageKeygen, ['-y', keyFile]);
  if (!/^age1[0-9a-z]+$/u.test(recipient)) throw new Error('age-keygen did not produce a synthetic recipient');

  await encryptStream(
    'docker',
    ['exec', sourceContainer, 'pg_dump', '-U', 'postgres', '-d', 'codexia', '-Fc'],
    agePath,
    recipient,
    path.join(backup, 'database.dump.age'),
    'database dump',
  );
  const historyDirectory = path.join(tempDirectory, 'history');
  const historyJobs = path.join(historyDirectory, 'jobs');
  await mkdir(historyJobs, { recursive: true });
  const historyJson =
    JSON.stringify({
      jobId: 'dbv007-contract-fixture',
      ownerId: identity.ownerId,
      revisionId: identity.revisionId,
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    }) + '\n';
  const historyPath = path.join(historyJobs, 'synthetic-owner-history.json');
  await writeFile(historyPath, historyJson, { mode: 0o600 });
  const historyHash = digest(Buffer.from(`${digest(Buffer.from(historyJson))}  ./jobs/synthetic-owner-history.json\n`));
  // The API writes history as UID/GID 1000 with mode 0600. The CI host runner
  // usually has a different UID, so encode the API identity explicitly in the
  // synthetic archive rather than accidentally testing the host runner's owner.
  const historyArchive = path.join(tempDirectory, 'history.tar');
  await writeFile(historyArchive, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  invoke('tar', ['--owner=1000', '--group=1000', '-C', historyDirectory, '-cf', historyArchive, '.']);
  assert.equal((await stat(historyArchive)).mode & 0o777, 0o600, 'temporary cleartext history archive must stay private');
  const archiveListing = output('tar', ['--numeric-owner', '-tvf', historyArchive]);
  const historyEntry = archiveListing.match(/^(-rw-------)\s+(1000\/1000)\s+.*jobs\/synthetic-owner-history\.json$/mu);
  assert.ok(historyEntry, 'synthetic history must retain private mode 0600 and API UID/GID 1000');
  await encryptStream('cat', [historyArchive], agePath, recipient, path.join(backup, 'history.tar.age'), 'history archive');
  await rm(historyArchive);

  const dbOutput = invoke(
    'docker',
    ['exec', '-i', sourceContainer, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'codexia'],
    {
      input: `SET TIME ZONE 'UTC';\nSET DateStyle TO ISO, YMD;\nSELECT format('SELECT %L; SELECT to_jsonb(t)::text FROM %I.%I t ORDER BY to_jsonb(t)::text COLLATE "C";', n.nspname || '.' || c.relname, n.nspname, c.relname)\nFROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace\nWHERE n.nspname IN ('public','codexia_auth') AND c.relkind IN ('r','p')\nORDER BY n.nspname, c.relname\n\\gexec\n`,
    },
  );
  const databaseFingerprint = digest(dbOutput);
  invoke(agePath, ['-r', recipient, '-o', path.join(backup, 'manifest.age')], {
    input: Buffer.from(`codexia-backup/v2\n${databaseFingerprint}\n${historyHash}\n`),
  });
  const checksums = [];
  for (const name of ['database.dump.age', 'history.tar.age', 'manifest.age']) {
    checksums.push(`${digest(await readFile(path.join(backup, name)))}  ${name}`);
  }
  const checksumBody = `${checksums.join('\n')}\n`;
  await writeFile(path.join(backup, 'SHA256SUMS'), checksumBody, { mode: 0o600 });
  const artifactDigest = digest(Buffer.from(checksumBody));

  // Keep a negative artifact with valid ciphertext checksums but a history
  // payload that disagrees with its still-authenticated v2 manifest. This
  // proves the real restore drill rejects altered history after decryption.
  const negativeBackup = path.join(evidenceDirectory, 'tampered-history-backup-v2');
  await mkdir(negativeBackup);
  await writeFile(path.join(negativeBackup, 'database.dump.age'), await readFile(path.join(backup, 'database.dump.age')), { mode: 0o600 });
  await writeFile(path.join(negativeBackup, 'manifest.age'), await readFile(path.join(backup, 'manifest.age')), { mode: 0o600 });
  const negativeHistoryDirectory = path.join(tempDirectory, 'tampered-history');
  const negativeJobs = path.join(negativeHistoryDirectory, 'jobs');
  await mkdir(negativeJobs, { recursive: true });
  await writeFile(path.join(negativeJobs, 'synthetic-owner-history.json'), `${historyJson.trimEnd()} tampered\n`, { mode: 0o600 });
  const negativeHistoryArchive = path.join(tempDirectory, 'tampered-history.tar');
  await writeFile(negativeHistoryArchive, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
  invoke('tar', ['--owner=1000', '--group=1000', '-C', negativeHistoryDirectory, '-cf', negativeHistoryArchive, '.']);
  assert.equal((await stat(negativeHistoryArchive)).mode & 0o777, 0o600, 'temporary tampered cleartext history archive must stay private');
  const negativeHistoryEntry = output('tar', ['--numeric-owner', '-tvf', negativeHistoryArchive]).match(
    /^(-rw-------)\s+(1000\/1000)\s+.*jobs\/synthetic-owner-history\.json$/mu,
  );
  assert.ok(negativeHistoryEntry, 'tampered negative must use the same private API UID/GID as the positive fixture');
  assert.deepEqual(negativeHistoryEntry.slice(1), historyEntry.slice(1));
  await encryptStream(
    'cat',
    [negativeHistoryArchive],
    agePath,
    recipient,
    path.join(negativeBackup, 'history.tar.age'),
    'tampered history archive',
  );
  await rm(negativeHistoryArchive);
  const negativeChecksums = [];
  for (const name of ['database.dump.age', 'history.tar.age', 'manifest.age']) {
    negativeChecksums.push(`${digest(await readFile(path.join(negativeBackup, name)))}  ${name}`);
  }
  await writeFile(path.join(negativeBackup, 'SHA256SUMS'), `${negativeChecksums.join('\n')}\n`, { mode: 0o600 });

  // The source Docker engine and the local rootless Podman target are
  // separate container stores. Use the same immutable PostgreSQL image;
  // no nested privileged engine, tar transfer or substituted executable.
  assert.equal(process.platform, 'linux', 'Isolated restore requires a local Linux Podman host');
  assert.notEqual(process.getuid(), 0, 'Isolated restore must run as an unprivileged user');
  const env = {
    ...process.env,
    PATH: `${ageDirectory}:${process.env.PATH}`,
    CODEXIA_PUSH_STATE_DIR: path.join(tempDirectory, 'restore-state'),
  };
  delete env.CONTAINER_HOST;
  delete env.CONTAINER_CONNECTION;
  delete env.CONTAINER_SSHKEY;
  const podmanInfo = JSON.parse(output('podman', ['info', '--format', 'json'], { env }));
  assert.equal(podmanInfo.host.security.rootless, true, 'Restore engine must be rootless');
  assert.equal(podmanInfo.host.serviceIsRemote, false, 'Restore engine must be local');
  const podmanVersion = output('podman', ['--version'], { env });
  assert.match(podmanVersion, /^podman version \S+/u);
  const restoreStarted = performance.now();
  const postgresId = output('docker', ['image', 'inspect', '--format', '{{.Id}}', pgImage]);
  invoke('podman', ['pull', pgImage], { env });
  const restoredImageId = output('podman', ['image', 'inspect', '--format', '{{.Id}}', pgImage], { env });
  assert.equal(
    restoredImageId.replace(/^sha256:/u, ''),
    postgresId.replace(/^sha256:/u, ''),
    'The restore engine must use the exact source PostgreSQL image config',
  );
  const authSql = path.join(contractDirectory, 'restore-proof-auth.sql');
  const restoreScript = path.join(contractDirectory, 'restore-proof.sh');
  const sourceAuthDefinitions = invoke(
    'docker',
    ['exec', '-i', sourceContainer, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'codexia'],
    {
      input: await readFile(authSql),
    },
  )
    .toString('utf8')
    .trimEnd()
    .split('\n');
  assert.equal(
    `sha256:${digest(JSON.stringify(sourceAuthDefinitions))}`,
    expectedAuthFingerprint,
    'restore proof query matches the API auth schema fingerprint source',
  );
  const canonicalBackup = path.join(root, 'deploy/backup/backup.sh');
  const positiveLog = output('bash', [canonicalBackup, 'drill', backup, keyFile, '--approved'], { env });
  assert.match(positiveLog, /Isolated restore verified: database and history fingerprints match/u);
  await writeFile(path.join(proof, 'canonical-restore.txt'), `${positiveLog}\n`, { mode: 0o600 });
  invoke('bash', [restoreScript, backup, keyFile, proof, pgImage, restoredImageId, identity.projectId], { env });
  const negative = spawnSync('bash', [canonicalBackup, 'drill', negativeBackup, keyFile, '--approved'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(negative.error, undefined, 'Tampered history drill must execute');
  assert.equal(negative.status, 1, 'Tampered history restore must fail');
  await writeFile(path.join(proof, 'tampered-history-rejection.txt'), `${negative.stdout}\n${negative.stderr}`, { mode: 0o600 });
  console.log(`Native rootless restore: ${podmanVersion}; elapsed ${((performance.now() - restoreStarted) / 1000).toFixed(3)}s`);

  const ledger = JSON.parse(await readFile(path.join(proof, 'migration-ledger.json'), 'utf8'));
  assert.deepEqual(
    ledger,
    expectedLedger.map(row => [row.version, row.checksum]),
  );
  const definitions = (await readFile(path.join(proof, 'auth-definitions.txt'), 'utf8')).trimEnd().split('\n');
  const restoredAuthFingerprint = `sha256:${digest(JSON.stringify(definitions))}`;
  assert.deepEqual(definitions, sourceAuthDefinitions, 'restored auth schema definitions match the source');
  assert.equal(restoredAuthFingerprint, expectedAuthFingerprint);
  const restoredIdentity = JSON.parse(await readFile(path.join(proof, 'owner-identity.json'), 'utf8'));
  assert.deepEqual(restoredIdentity, {
    project_title: identity.projectTitle,
    document_id: identity.documentId,
    document_title: identity.documentTitle,
    head_revision_id: identity.revisionId,
    revision_id: identity.revisionId,
    revision_markdown: identity.manuscript,
    author_id: identity.ownerId,
    owner_id: identity.ownerId,
    owner_email: identity.ownerEmail,
  });
  const tamperedHistoryRejection = await readFile(path.join(proof, 'tampered-history-rejection.txt'), 'utf8');
  assert.match(
    tamperedHistoryRejection,
    /Restored history fingerprint mismatch/u,
    'the canonical restore drill must reject altered history with a valid ciphertext checksum list',
  );
  assert.doesNotMatch(
    tamperedHistoryRejection,
    /Permission denied|sha256sum:|cleanup failed/iu,
    'tampered history rejection must come from its digest mismatch, not a reader permission failure',
  );
  return {
    databaseFingerprint,
    historyHash,
    artifactDigest,
    restoredAuthFingerprint,
    tamperedHistoryRejected: true,
    podman: { version: podmanVersion, rootless: true, local: true, postgresImageId: restoredImageId },
  };
}

async function main() {
  const dockerEndpoint = output('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!dockerEndpoint.startsWith('unix://') && !dockerEndpoint.startsWith('npipe://')) {
    throw new Error('The disposable contract runner requires a local Docker engine context');
  }
  const source = await sourceIdentity();
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codexia-pg-contract-'));
  const evidenceParent = process.env.CODEXIA_CI_REPORT_DIR || path.join(root, 'work/postgres-contract-evidence');
  await mkdir(evidenceParent, { recursive: true });
  const evidenceDirectory = path.join(evidenceParent, `pg17-${Date.now()}-${randomBytes(3).toString('hex')}`);
  await mkdir(evidenceDirectory);
  const containerName = `codexia-db-contract-${process.pid}-${randomBytes(3).toString('hex')}`;
  let imageBuilt = false;
  let containerCreated = false;
  let adminPool;
  let databaseAdminPool;
  let appPool;
  let authPool;
  let catalogPool;
  let stage = 'toolchain download';
  try {
    const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
    if (!arch) throw new Error(`Unsupported database contract runner architecture ${process.arch}`);
    const tblsArchive = await download(toolchain.tbls.archives[arch], tempDirectory, 'tbls.tar.gz');
    const tblsDirectory = path.join(tempDirectory, 'tbls');
    await mkdir(tblsDirectory);
    invoke('tar', ['-xzf', tblsArchive, '-C', tblsDirectory]);
    const tblsPath = path.join(tblsDirectory, 'tbls');
    await chmod(tblsPath, 0o755);
    assert.equal(output(tblsPath, ['version']), toolchain.tbls.version);
    const ageArchive = await download(toolchain.restoreDrill.age.archives[arch], tempDirectory, 'age.tar.gz');
    const ageDirectory = path.join(tempDirectory, 'age');
    await mkdir(ageDirectory);
    invoke('tar', ['-xzf', ageArchive, '-C', ageDirectory]);
    const agePath = path.join(ageDirectory, 'age/age');
    await chmod(agePath, 0o755);
    await chmod(path.join(ageDirectory, 'age/age-keygen'), 0o755);

    invoke(
      'docker',
      [
        'build',
        '--file',
        path.join(contractDirectory, 'Dockerfile'),
        '--tag',
        contractImage,
        '--build-arg',
        `POSTGRES_IMAGE=${pgImage}`,
        '--build-arg',
        `PGTAP_VERSION=${toolchain.pgtap.version}`,
        '--build-arg',
        `PGTAP_ARCHIVE_SHA256=${toolchain.pgtap.archiveSha256}`,
        '--build-arg',
        `MAKE_VERSION=${toolchain.buildPackages.make}`,
        '--build-arg',
        `PATCH_VERSION=${toolchain.buildPackages.patch}`,
        '.',
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    imageBuilt = true;

    stage = 'disposable PostgreSQL startup';
    const postgresPassword = secret();
    const applicationPassword = secret();
    const administratorPassword = secret();
    const authPassword = secret();
    output('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      `POSTGRES_PASSWORD=${postgresPassword}`,
      '--env',
      'POSTGRES_DB=postgres',
      contractImage,
    ]);
    containerCreated = true;
    const hostPort = output('docker', ['port', containerName, '5432/tcp']).match(/:(\d+)$/u)?.[1];
    if (!hostPort) throw new Error('PostgreSQL contract container did not publish a loopback port');
    const port = Number(hostPort);
    adminPool = new Pool({ connectionString: url({ port, database: 'postgres', user: 'postgres', password: postgresPassword }) });
    await waitForDatabase(adminPool, 'PostgreSQL contract database');
    await adminPool.query(`CREATE ROLE codexia_admin LOGIN SUPERUSER PASSWORD ${literal(administratorPassword)}`);
    await adminPool.query(
      `CREATE ROLE codexia LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(applicationPassword)}`,
    );
    await adminPool.query('CREATE DATABASE codexia OWNER codexia');
    await adminPool.query(
      `CREATE ROLE codexia_auth_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(authPassword)}`,
    );
    const applicationUrl = url({ port, database: 'codexia', user: 'codexia', password: applicationPassword });
    const authUrl = url({ port, database: 'codexia', user: 'codexia_auth_runtime', password: authPassword });
    databaseAdminPool = new Pool({ connectionString: url({ port, database: 'codexia', user: 'postgres', password: postgresPassword }) });
    await waitForDatabase(databaseAdminPool, 'application database');
    await initializeFreshPostgresSchema(applicationUrl);
    const migrationFingerprint = await verifyPostgresSchema(applicationUrl);
    assert.equal(migrationFingerprint, await packagedMigrationFingerprint());
    await databaseAdminPool.query('CREATE SCHEMA codexia_auth AUTHORIZATION codexia_auth_runtime');
    await adminPool.query('ALTER ROLE codexia_auth_runtime IN DATABASE codexia SET search_path TO codexia_auth');

    const syntheticEnvironment = {
      CODEXIA_AUTH_DATABASE_URL: authUrl,
      CODEXIA_PUBLIC_ORIGIN: 'https://contract.example.invalid',
      CODEXIA_AUTH_SECRET: secret(),
      CODEXIA_OAUTH_INTROSPECTION_CLIENT_ID: 'contract-introspection-client',
      CODEXIA_OAUTH_INTROSPECTION_CLIENT_SECRET: secret(),
      CODEXIA_OAUTH_OWNER_SUBJECT: 'codexia-655-synthetic-owner',
      CODEXIA_OAUTH_OWNER_CLIENT_IDS: 'contract-owner-client',
      CODEXIA_OAUTH_MCP_CLIENT_IDS: '',
    };
    stage = 'official Better Auth migrations';
    const previousEnvironment = new Map(Object.keys(syntheticEnvironment).map(key => [key, process.env[key]]));
    Object.assign(process.env, syntheticEnvironment);
    try {
      await migrateBetterAuth(readBetterAuthMigrationConfig(false));
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    appPool = new Pool({ connectionString: applicationUrl });
    authPool = new Pool({ connectionString: authUrl });
    await waitForDatabase(appPool, 'application migration database');
    await waitForDatabase(authPool, 'authentication migration database');
    await verifyAuthSchema(authPool);
    const authFingerprint = await authSchemaFingerprint(authPool);
    const authRuntimeGrant = await authPool.query(`SELECT current_user AS role,current_schema() AS schema,
      has_schema_privilege(current_user,'codexia_auth','USAGE') AS schema_usage,
      has_table_privilege(current_user,'codexia_auth.user','INSERT') AS user_insert,
      has_table_privilege(current_user,'codexia_auth.user','SELECT') AS user_select`);
    if (!authRuntimeGrant.rows[0]?.schema_usage || !authRuntimeGrant.rows[0]?.user_insert) {
      throw new Error('Better Auth migration did not leave the isolated runtime able to manage its owner identity');
    }
    stage = 'DBV-007 synthetic owner and manuscript seed';
    const identity = await seedRestoreIdentity(appPool, authPool);
    await verifyRestoreIdentity(databaseAdminPool, identity);
    await appPool.end();
    appPool = undefined;
    await authPool.end();
    authPool = undefined;
    await databaseAdminPool.end();
    databaseAdminPool = undefined;
    invoke('docker', ['exec', '-i', containerName, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'codexia'], {
      input: await readFile(path.join(root, 'deploy/ansible/verify-postgres-roles.sql')),
    });
    const postgresVersion = output('docker', [
      'exec',
      containerName,
      'psql',
      '-X',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      'codexia',
      '-c',
      'SHOW server_version',
    ]);
    if (!postgresVersion.startsWith(`${toolchain.postgresMajor}.`)) throw new Error(`Expected PostgreSQL ${toolchain.postgresMajor}`);
    stage = 'pg_catalog contract comparison';
    catalogPool = new Pool({ connectionString: url({ port, database: 'codexia', user: 'postgres', password: postgresPassword }) });
    const installedCatalog = await catalog(catalogPool);
    await catalogPool.end();
    catalogPool = undefined;
    const catalogPath = path.join(contractDirectory, 'catalog-contract.json');
    if (updateContract) {
      await writeFile(catalogPath, `${JSON.stringify(installedCatalog, null, 2)}\n`);
      console.log(`Reviewed pg_catalog fixture generated at ${path.relative(root, catalogPath)}`);
      return;
    }
    const reviewedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    assertCatalogMatches(reviewedCatalog, installedCatalog);
    stage = 'migration and schema drift rejection';
    const drift = await assertDriftDetected({ adminPool, port, postgresPassword, applicationPassword, expected: reviewedCatalog });
    stage = 'pgTAP physical acceptance';
    const pgTap = await createPgtapDatabase({ adminPool, containerName, port, password: postgresPassword });

    const tblsOutput = path.join(evidenceDirectory, 'tbls');
    await mkdir(tblsOutput);
    stage = 'tbls data dictionary generation';
    const tblsReaderUrl = await prepareTblsReader({ adminPool, port, postgresPassword });
    invoke(
      tblsPath,
      [
        'doc',
        `${tblsReaderUrl}?sslmode=disable`,
        tblsOutput,
        '--force',
        '--er-format',
        'mermaid',
        '--include',
        'public.*',
        '--include',
        'codexia_auth.*',
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    stage = 'encrypted v2 isolated restore';
    const restore = await verifyEncryptedRestore({
      tempDirectory,
      evidenceDirectory,
      agePath,
      sourceContainer: containerName,
      identity,
      expectedLedger: reviewedCatalog.migrationLedger,
      expectedAuthFingerprint: authFingerprint,
    });

    const catalogFingerprint = `sha256:${digest(JSON.stringify(installedCatalog))}`;
    const generatedTblsFiles = await listFiles(tblsOutput);
    assert.ok(
      generatedTblsFiles.includes('README.md') && generatedTblsFiles.includes('public.project.md'),
      'tbls must generate the data dictionary in the task artifact directory',
    );
    const generatedTblsIdentity = await Promise.all(
      generatedTblsFiles.map(async file => ({
        path: file,
        sha256: digest(await readFile(path.join(tblsOutput, file))),
      })),
    );
    const tblsArtifactFingerprint = `sha256:${digest(JSON.stringify(generatedTblsIdentity))}`;
    const manifest = {
      format: 'codexia-postgres-contract-evidence/v1',
      source,
      runtime: {
        postgresVersion,
        postgresMajor: toolchain.postgresMajor,
        pgTap: { version: toolchain.pgtap.version, extensionVersion: toolchain.pgtap.version },
        tbls: { version: toolchain.tbls.version, archiveSha256: toolchain.tbls.archives[arch].sha256 },
        age: { version: toolchain.restoreDrill.age.version, archiveSha256: toolchain.restoreDrill.age.archives[arch].sha256 },
        podman: restore.podman,
      },
      schema: { migrationFingerprint, authFingerprint, catalogFingerprint, migrationLedger: reviewedCatalog.migrationLedger },
      tests: { pgTap, drift, tblsReadOnly: true, roleContractSql: 'deploy/ansible/verify-postgres-roles.sql' },
      restore: {
        format: 'codexia-backup/v2',
        encrypted: true,
        isolatedTargetNetwork: 'none',
        databaseFingerprint: restore.databaseFingerprint,
        historyFingerprint: restore.historyHash,
        artifactSha256: restore.artifactDigest,
        authFingerprint: restore.restoredAuthFingerprint,
        ownerIdentity: {
          ownerId: identity.ownerId,
          ownerEmail: identity.ownerEmail,
          projectId: identity.projectId,
          documentId: identity.documentId,
          revisionId: identity.revisionId,
        },
        canonicalScript: 'deploy/backup/backup.sh',
      },
      artifacts: {
        tbls: 'tbls/',
        tblsFileCount: generatedTblsFiles.length,
        tblsFingerprint: tblsArtifactFingerprint,
        encryptedBackup: 'encrypted-backup-v2/',
        tamperedHistoryBackup: 'tampered-history-backup-v2/',
        restoreProof: 'restore-proof/',
      },
    };
    const serialized = JSON.stringify(manifest, null, 2);
    if (/postgres:\/\/|password|secret/iu.test(serialized))
      throw new Error('Evidence manifest contains a forbidden connection or credential field');
    await writeFile(
      path.join(tblsOutput, '_source-identity.json'),
      `${JSON.stringify(
        {
          source,
          migrationFingerprint,
          authFingerprint,
          catalogFingerprint,
          postgresVersion,
          generator: { name: 'tbls', version: toolchain.tbls.version, archiveSha256: toolchain.tbls.archives[arch].sha256 },
          generatedFiles: { count: generatedTblsFiles.length, fingerprint: tblsArtifactFingerprint },
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    await writeFile(path.join(evidenceDirectory, 'manifest.json'), `${serialized}\n`, { flag: 'wx' });
    console.log(`DB contract PASS: PostgreSQL ${toolchain.postgresMajor}; ${pgTap.executed} pgTAP assertions; ${catalogFingerprint}`);
    console.log(`Encrypted v2 restore PASS; evidence saved at ${path.relative(root, evidenceDirectory)}`);
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally {
    await catalogPool?.end().catch(() => undefined);
    await appPool?.end().catch(() => undefined);
    await authPool?.end().catch(() => undefined);
    await databaseAdminPool?.end();
    await adminPool?.end();
    if (containerCreated) invoke('docker', ['rm', '--force', containerName], { maxBuffer: 1024 * 1024 });
    if (imageBuilt) invoke('docker', ['image', 'rm', '--force', contractImage], { maxBuffer: 1024 * 1024 });
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`PostgreSQL contract verification failed: ${error.message}\n`);
  process.exitCode = 1;
});
