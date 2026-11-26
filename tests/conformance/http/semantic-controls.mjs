import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';

// Actual HTTP/PostgreSQL controls for each semantic precondition.
export async function verifySemanticControls(origin, token) {
  const prefix = '/api/v1/persistence/projects';
  const outcomes = [];
  const request = async (label, path, method = 'GET', body, headers = {}, status = 200, code) => {
    const response = await fetch(origin + path, {
      method, headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    assert.equal(response.status, status, label + ': ' + JSON.stringify(result).slice(0, 300));
    if (code) assert.equal(result.code, code, label);
    outcomes.push({ label, status, ...(code ? { code } : {}) });
    return result;
  };
  const key = () => ({ 'Idempotency-Key': randomUUID() });
  const { project } = await request('create project', prefix, 'POST', { title: 'Conformance ' + randomUUID() }, {}, 201);
  await request('create second project', prefix, 'POST', { title: 'Conformance ' + randomUUID() }, {}, 201);
  const root = prefix + '/' + project.id;
  const page = await request('project page', prefix + '?limit=1');
  assert.ok(page.nextCursor);
  await request('valid project cursor', prefix + '?limit=1&cursor=' + encodeURIComponent(page.nextCursor));
  await request('invalid project cursor', prefix + '?cursor=', 'GET', undefined, {}, 400, 'INVALID_CURSOR');

  const created = await request('create document', root + '/documents', 'POST',
    { title: 'Scene', kind: 'scene', markdown: 'initial' }, key(), 201);
  const doc = root + '/documents/' + created.document.id;
  const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const saveBody = { baseRevisionId: created.revision.id, changes: [{ fromUtf16: 7, toUtf16: 7, insert: '!' }], resultingSha256: hash('initial!') };
  await request('missing conditional client identity', doc, 'PATCH', saveBody, key(), 400, 'INVALID_BODY');
  const saved = await request('header-only client identity', doc, 'PATCH', saveBody, { ...key(), 'X-Client-Id': 'conformance' });
  const savedAgain = await request('body-only client identity', doc, 'PATCH', {
    baseRevisionId: saved.revision.id, changes: [{ fromUtf16: 8, toUtf16: 8, insert: '!' }],
    resultingSha256: hash('initial!!'), clientId: 'conformance',
  }, key());
  assert.equal(savedAgain.revision.markdown, 'initial!!');
  const revisions = await request('revision page', doc + '/revisions?limit=1');
  assert.ok(revisions.nextBefore);
  await request('valid revision cursor', doc + '/revisions?limit=1&before=' + encodeURIComponent(revisions.nextBefore));

  const ids = [randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    await request('create knowledge node ' + index, root + '/nodes/' + id, 'PUT',
      { type: 'lore', name: 'Node ' + index, attributes: {}, status: 'confirmed', expectedVersion: null });
  }
  const nodes = await request('knowledge page', root + '/nodes?q=&limit=1');
  assert.ok(nodes.nextCursor);
  await request('valid knowledge cursor', root + '/nodes?q=&limit=1&cursor=' + encodeURIComponent(nodes.nextCursor));
  await request('invalid knowledge cursor', root + '/nodes?q=&cursor=', 'GET', undefined, {}, 400, 'INVALID_CURSOR');
  await request('distinct merge preview', root + '/nodes/' + ids[0] + '/merge-preview', 'POST', { targetId: ids[1] });
  await request('self merge rejection', root + '/nodes/' + ids[0] + '/merge-preview', 'POST', { targetId: ids[0] }, {}, 400, 'PERSISTENCE_VALIDATION');

  const archive = await request('export archive', root + '/archive');
  const duplicate = { moduleId: 'conformance', key: 'duplicate', value: {} };
  await request('duplicate archive record rejection', '/api/v1/persistence/import', 'POST',
    { ...archive, moduleRecords: [duplicate, duplicate] }, {}, 400, 'INVALID_WORK_ARCHIVE');
  await request('valid archive import', '/api/v1/persistence/import', 'POST', archive, {}, 201);
  const current = await request('current project version', root);
  const command = { projectId: project.id, id: randomUUID(), type: 'lore', name: 'Proposed node', attributes: {}, status: 'proposed', expectedVersion: null };
  const proposal = { projectVersion: current.project.version, operations: [{ type: 'knowledge.node.save', command }] };
  await request('cross-project changeset rejection', root + '/changesets', 'POST',
    { ...proposal, operations: [{ type: 'knowledge.node.save', command: { ...command, projectId: randomUUID() } }] }, key(), 400, 'INVALID_INPUT');
  await request('valid changeset proposal', root + '/changesets', 'POST', proposal, key(), 201);
  return outcomes;
}
