import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPostgresPersistence, migratePostgresDatabase } from '../../packages/persistence-postgres/dist/index.js';
import { CoreStore } from '../../packages/core/dist/index.js';

const requirePersistence = createRequire(new URL('../../packages/persistence-postgres/package.json', import.meta.url));
const { Client } = requirePersistence('pg');
const authorId = 'synthetic-benchmark-author';
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function databaseTarget(connectionString) {
  let parsed;
  try { parsed = new URL(connectionString); }
  catch { throw new Error('CODEXIA_TEST_DATABASE_URL must be a PostgreSQL URL for a disposable loopback database'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Performance fixtures require a PostgreSQL URL');
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  const host = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const overriddenHosts = [...parsed.searchParams.getAll('host'), ...parsed.searchParams.getAll('hostaddr')]
    .flatMap(value => value.split(',')).map(value => value.replace(/^\[|\]$/gu, '').toLowerCase());
  if (!loopbackHosts.has(host) || overriddenHosts.some(value => !loopbackHosts.has(value)) ||
      parsed.searchParams.has('service') || parsed.searchParams.has('servicefile')) {
    throw new Error('Performance fixtures only run against loopback PostgreSQL');
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (parsed.searchParams.has('dbname') && parsed.searchParams.get('dbname') !== database) {
    throw new Error('Performance fixture URL cannot override its disposable database name');
  }
  if (!/^codexia_perf_[a-z0-9_-]+$/u.test(database) && !['codexia_test', 'codexia_e2e'].includes(database)) {
    throw new Error('Disposable performance database must use codexia_perf_*, codexia_test, or codexia_e2e');
  }
  const explicitPorts = parsed.searchParams.getAll('port');
  const port = explicitPorts.length ? Number(explicitPorts[0]) : parsed.port ? Number(parsed.port) : 5432;
  if (explicitPorts.length > 1 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Performance fixture URL must select one valid PostgreSQL port');
  }
  return { host: parsed.searchParams.get('host') ?? parsed.hostname, hostaddr: parsed.searchParams.get('hostaddr') ?? null,
    port, database, user: parsed.searchParams.get('user') || decodeURIComponent(parsed.username),
    sslMode: parsed.searchParams.get('sslmode') ?? 'default' };
}

async function databaseIdentity(connectionString, poolMax) {
  const target = databaseTarget(connectionString);
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const [result, settingsResult] = await Promise.all([client.query(`SELECT current_database() AS database,
      current_setting('server_version') AS server_version,
      current_setting('shared_buffers') AS shared_buffers,
      current_setting('work_mem') AS work_mem,
      current_setting('effective_cache_size') AS effective_cache_size,
      current_setting('max_connections') AS max_connections,
      current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS synchronous_commit,
      current_setting('default_transaction_isolation') AS default_transaction_isolation,
      pg_database_size(current_database()) AS database_bytes`), client.query(`SELECT name, setting, unit, source, pending_restart
        FROM pg_settings ORDER BY name`)]);
    const settings = settingsResult.rows;
    return { ...target, poolMax, ...result.rows[0], database_bytes: Number(result.rows[0].database_bytes),
      settings, settingsSha256: sha256(JSON.stringify(settings)) };
  } finally { await client.end(); }
}

async function persistedInventory(connectionString, projectId) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await client.query(`SELECT
      (SELECT count(*) FROM document d WHERE d.project_id = $1) AS document_count,
      (SELECT coalesce(sum(pg_column_size(d)), 0) FROM document d WHERE d.project_id = $1) AS document_tuple_bytes,
      (SELECT count(*) FROM document_revision r WHERE r.project_id = $1) AS revision_count,
      (SELECT coalesce(sum(octet_length(r.markdown)), 0) FROM document_revision r WHERE r.project_id = $1) AS revision_markdown_bytes,
      (SELECT coalesce(sum(pg_column_size(r)), 0) FROM document_revision r WHERE r.project_id = $1) AS revision_tuple_bytes,
      (SELECT coalesce(sum(octet_length(r.markdown)), 0) FROM document d JOIN document_revision r
        ON r.project_id = d.project_id AND r.document_id = d.id AND r.id = d.head_revision_id WHERE d.project_id = $1) AS current_markdown_bytes,
      (SELECT count(*) FROM knowledge_node n WHERE n.project_id = $1) AS knowledge_nodes,
      (SELECT count(*) FROM knowledge_alias a WHERE a.project_id = $1) AS knowledge_aliases,
      (SELECT count(*) FROM knowledge_relation r WHERE r.project_id = $1) AS knowledge_relations,
      (SELECT coalesce(sum(pg_column_size(n)), 0) FROM knowledge_node n WHERE n.project_id = $1) +
        (SELECT coalesce(sum(pg_column_size(a)), 0) FROM knowledge_alias a WHERE a.project_id = $1) +
        (SELECT coalesce(sum(pg_column_size(r)), 0) FROM knowledge_relation r WHERE r.project_id = $1) AS knowledge_tuple_bytes,
      (SELECT count(*) FROM text_anchor a WHERE a.project_id = $1) AS evidence_anchors,
      (SELECT count(*) FROM anchor_history h WHERE h.project_id = $1) AS evidence_history,
      (SELECT count(*) FROM mention_link m WHERE m.project_id = $1) AS evidence_mentions,
      (SELECT count(*) FROM assertion a WHERE a.project_id = $1) AS evidence_assertions,
      (SELECT count(*) FROM assertion_evidence ae WHERE ae.project_id = $1) AS assertion_evidence_links,
      (SELECT coalesce(sum(pg_column_size(a)), 0) FROM text_anchor a WHERE a.project_id = $1) +
        (SELECT coalesce(sum(pg_column_size(h)), 0) FROM anchor_history h WHERE h.project_id = $1) +
        (SELECT coalesce(sum(pg_column_size(m)), 0) FROM mention_link m WHERE m.project_id = $1) +
        (SELECT coalesce(sum(pg_column_size(a)), 0) FROM assertion a WHERE a.project_id = $1) +
        (SELECT coalesce(sum(pg_column_size(ae)), 0) FROM assertion_evidence ae WHERE ae.project_id = $1) AS evidence_tuple_bytes`, [projectId]);
    const row = Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
    return { documentCount: row.document_count, documentTupleBytes: row.document_tuple_bytes,
      revisionCount: row.revision_count, revisionMarkdownBytes: row.revision_markdown_bytes,
      revisionTupleBytes: row.revision_tuple_bytes, currentMarkdownBytes: row.current_markdown_bytes,
      knowledge: { nodes: row.knowledge_nodes, aliases: row.knowledge_aliases, relations: row.knowledge_relations,
        tupleBytes: row.knowledge_tuple_bytes },
      evidence: { anchors: row.evidence_anchors, history: row.evidence_history, mentions: row.evidence_mentions,
        assertions: row.evidence_assertions, assertionLinks: row.assertion_evidence_links,
        tupleBytes: row.evidence_tuple_bytes } };
  } finally { await client.end(); }
}

async function seedKnowledgeEvidence(persistence, projectId, scenes, profile) {
  const knowledge = profile.knowledge;
  if (!knowledge?.nodes) return;
  let anchorIndex = 0;
  for (let start = 0; start < knowledge.nodes; start += 10) {
    const operations = [], writeSet = [], readSet = [];
    for (let offset = start; offset < Math.min(start + 10, knowledge.nodes); offset++) {
      const scene = scenes[offset % scenes.length];
      const nodeId = randomUUID();
      const assertionId = randomUUID();
      const evidence = [];
      operations.push({ type: 'knowledge.node.save', command: { projectId, id: nodeId, type: 'lore',
        name: `Synthetic knowledge ${offset + 1}`, attributes: { fixture: profile.fixtureId, ordinal: offset + 1 },
        status: 'confirmed', expectedVersion: null } });
      writeSet.push({ resource: 'knowledge_node', id: nodeId });
      for (let aliasIndex = 0; aliasIndex < knowledge.aliasesPerNode; aliasIndex++) {
        const id = randomUUID();
        const surface = `Synthetic knowledge ${offset + 1} alias ${aliasIndex + 1}`;
        operations.push({ type: 'knowledge.alias.save', command: { projectId, id, nodeId, surface,
          normalized: surface.toLocaleLowerCase(), scope: null, status: 'confirmed' } });
        writeSet.push({ resource: 'knowledge_alias', id });
      }
      for (let item = 0; item < knowledge.evidencePerNode; item++) {
        const id = randomUUID();
        const fromUtf16 = 20 + item * 8;
        const toUtf16 = Math.min(scene.revision.markdown.length, fromUtf16 + 32);
        const quote = scene.revision.markdown.slice(fromUtf16, toUtf16);
        if (!quote.length) throw new Error('Synthetic evidence quote must not be empty');
        operations.push({ type: 'evidence.anchor.save', command: { projectId, id, documentId: scene.document.id,
          revisionId: scene.revision.id, fromUtf16, toUtf16, quoteSha256: sha256(quote), status: 'confirmed', expectedVersion: null } });
        operations.push({ type: 'evidence.mention.save', command: { projectId, evidenceId: id, nodeId,
          status: 'confirmed', source: 'author', confidence: 1, extractorVersion: null } });
        evidence.push(id);
        writeSet.push({ resource: 'evidence_anchor', id }, { resource: 'mention_link', id: `${id}:${nodeId}` });
        anchorIndex++;
      }
      if (knowledge.assertionsPerNode > 0) {
        operations.push({ type: 'evidence.assertion.save', command: { projectId, id: assertionId,
          proposition: { subject: nodeId, predicate: 'has synthetic supporting passage', object: `passage-${offset + 1}` },
          modality: 'certain', perspective: 'author', narrativeTime: { sceneId: scene.document.id },
          confidence: 1, status: 'confirmed', expectedVersion: null } });
        operations.push({ type: 'evidence.assertion.link', command: { projectId, assertionId, evidenceId: evidence[0], role: 'supports' } });
        writeSet.push({ resource: 'assertion', id: assertionId },
          { resource: 'assertion_evidence', id: `${assertionId}:${evidence[0]}` });
      }
      readSet.push({ resource: 'document', id: scene.document.id, expectedVersion: scene.document.version,
        expectedRevisionId: scene.revision.id });
    }
    await persistence.transaction(async transaction => {
      const changeSet = await transaction.createChangeSet({ projectId, authorId,
        idempotencyKey: `${profile.fixtureId}:knowledge:${start}`, operations, readSet, writeSet,
        provenance: { source: 'author', actorId: authorId, details: { fixture: profile.fixtureId } } });
      const approved = await transaction.approveChangeSet({ projectId, changeSetId: changeSet.changeSet.id,
        expectedVersion: changeSet.changeSet.version, approvedBy: authorId });
      const applied = await transaction.applyChangeSet({ projectId, changeSetId: approved.id,
        expectedVersion: approved.version });
      if (applied.changeSet.status !== 'applied') throw new Error('Synthetic Knowledge/Evidence ChangeSet was not applied');
    });
  }
  return { nodes: knowledge.nodes, aliases: knowledge.nodes * knowledge.aliasesPerNode,
    anchors: anchorIndex, assertions: knowledge.nodes * knowledge.assertionsPerNode };
}

/** Materialize only deterministic synthetic input in an isolated loopback PostgreSQL database. */
export async function postgresFixture(datasetPath) {
  const setupStart = performance.now();
  const url = process.env.CODEXIA_TEST_DATABASE_URL;
  if (!url) throw new Error('CODEXIA_TEST_DATABASE_URL must select a disposable loopback database named codexia_perf_*');
  const target = databaseTarget(url);
  const poolMax = Number(process.env.CODEXIA_PERF_POOL_MAX ?? 10);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) throw new Error('CODEXIA_PERF_POOL_MAX must be an integer from 1 to 100');
  await migratePostgresDatabase(url);
  const persistence = createPostgresPersistence({ connectionString: url, max: poolMax });
  try {
    const profile = JSON.parse(await readFile(join(datasetPath, 'dataset.json'), 'utf8'));
    if (profile.schemaVersion !== 2 || !/^[a-f0-9]{64}$/u.test(profile.fixtureId)) throw new Error('Invalid deterministic fixture manifest');
    const plan = JSON.parse(await readFile(join(datasetPath, 'seed', 'fixture-plan.json'), 'utf8'));
    if (plan.fixtureId !== undefined) throw new Error('Fixture transport plan cannot contain runtime state');
    const store = new CoreStore({ persistence });
    const project = await store.createProject({ title: `Synthetic benchmark ${profile.datasetId}` });
    const volumes = [], chapters = [], sceneRecords = [];
    const chapterCountByVolume = Array.from({ length: profile.volumeCount }, (_, volumeIndex) =>
      Math.floor(profile.chapterCount / profile.volumeCount) + (volumeIndex < profile.chapterCount % profile.volumeCount ? 1 : 0));
    await persistence.transaction(async transaction => {
      for (let index = 0; index < profile.volumeCount; index++) {
        const created = await transaction.createDocument({ projectId: project.id, kind: 'volume', title: `Volume ${index + 1}`,
          orderKey: String(index + 1).padStart(4, '0'), markdown: '', authorId,
          idempotencyKey: `${profile.fixtureId}:volume:${index + 1}` });
        volumes.push(created.document);
      }
      let chapterIndex = 0;
      for (let volumeIndex = 0; volumeIndex < volumes.length; volumeIndex++) {
        for (let local = 0; local < chapterCountByVolume[volumeIndex]; local++) {
          chapterIndex++;
          const created = await transaction.createDocument({ projectId: project.id, parentId: volumes[volumeIndex].id,
            kind: 'chapter', title: `Chapter ${chapterIndex}`, orderKey: String(local + 1).padStart(4, '0'), markdown: '', authorId,
            idempotencyKey: `${profile.fixtureId}:chapter:${chapterIndex}` });
          chapters.push({ document: created.document, volumeIndex });
        }
      }
      for (let index = 0; index < profile.scenes.length; index++) {
        const scene = profile.scenes[index];
        const chapter = chapters[index % chapters.length];
        const markdown = await readFile(join(datasetPath, 'seed', scene.name), 'utf8');
        if (Buffer.byteLength(markdown) !== scene.bodyBytes) throw new Error(`Fixture body byte mismatch: ${scene.name}`);
        const created = await transaction.createDocument({ projectId: project.id, parentId: chapter.document.id,
          kind: 'scene', title: scene.title, orderKey: String(index + 1).padStart(6, '0'), markdown, authorId,
          idempotencyKey: `${profile.fixtureId}:scene:${index + 1}` });
        sceneRecords.push({ ...created, title: scene.title, index: index + 1 });
      }
    });
    const historyTarget = sceneRecords[0];
    for (let index = 1; index <= profile.historyTarget.additionalRevisions; index++) {
      const current = await persistence.read(async reader => ({
        document: await reader.getDocument(project.id, historyTarget.document.id),
        revision: await reader.getRevision(project.id, historyTarget.document.id, historyTarget.document.headRevisionId),
      }));
      if (!current.document || !current.revision) throw new Error('Revision history seed lost its target document');
      const markdown = `${current.revision.markdown}\nSynthetic historical edit ${index}.`;
      const saved = await persistence.transaction(transaction => transaction.saveDocument({ projectId: project.id,
        documentId: current.document.id, baseRevisionId: current.revision.id,
        changes: [{ fromUtf16: 0, toUtf16: current.revision.markdown.length, insert: markdown }],
        resultingSha256: sha256(markdown), authorId, clientId: 'performance-fixture',
        idempotencyKey: `${profile.fixtureId}:history:${index}` }));
      historyTarget.document = saved.document; historyTarget.revision = saved.revision;
    }
    const knowledgeSeed = await seedKnowledgeEvidence(persistence, project.id, sceneRecords, profile);
    const inventory = await persistedInventory(url, project.id);
    if (inventory.documentCount !== profile.documentCount || inventory.revisionCount !== profile.documentCount + profile.historyTarget.additionalRevisions) {
      throw new Error(`Persisted fixture count mismatch: ${inventory.documentCount} documents and ${inventory.revisionCount} revisions`);
    }
    if (knowledgeSeed && inventory.knowledge.nodes !== knowledgeSeed.nodes) throw new Error('Persisted Knowledge count mismatch');
    const database = await databaseIdentity(url, poolMax);
    const setupMs = performance.now() - setupStart;
    return { store, project, scenes: sceneRecords.map(row => row.document.id), sceneRecords,
      historyTarget: { document: historyTarget.document, revision: historyTarget.revision },
      persistence, setupMs, inventory, database, knowledgeSeed };
  } catch (error) { await persistence.close(); throw error; }
}
