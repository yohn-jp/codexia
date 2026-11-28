#!/usr/bin/env node
// Build and verify the public, static Pages entry point and site registry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readApprovedOpenapi } from '../../packages/http-contract/scripts/approved-openapi.mjs';
import { containsCredentialPattern } from './publication-policy.mjs';
import { verifySpecifications } from './specifications.mjs';
import { LIKEC4_OPERATIONS_VIEW_ID, LIKEC4_SOURCE_PATH, LIKEC4_VERSION, LIKEC4_VIEW_ID } from '../architecture/contract.mjs';
import { LIKEC4_PUBLIC_BUNDLE, LIKEC4_PUBLIC_LICENSE } from '../architecture/webcomponent.mjs';
import { inspectUxArtifact } from './ux-artifact.mjs';

const self = fileURLToPath(import.meta.url);
const CANONICAL_ORIGIN = 'https://yohn-jp.github.io/codexia';
const MAX_SITE_BYTES = 900 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const SNAPSHOT_OUTPUT = /^(?:repomix\.json|part-\d{4,}\.json)$/u;
const REVIEW_OUTPUTS = new Set(['gemini-review.md','gemini-diff.md','preview.json','rules.json','index.md','index.html']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const esc = value => String(value).replace(/[&<>"']/gu, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

function readPageFile(path, encoding, message = 'Expected a regular Pages file') {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    assert.ok(fstatSync(fd).isFile(), message);
    return readFileSync(fd, encoding);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EMLINK'].includes(error.code)) throw new Error(message, { cause: error });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function canonicalOrigin(value) {
  assert.ok(value===CANONICAL_ORIGIN,'Pages origin must be the canonical public repository site');
  return value;
}

function page(site, route) {
  const path = route === '/' ? 'index.html' : route.endsWith('/') ? route.slice(1) + 'index.html' : route.slice(1);
  return join(site, path);
}

function likec4Provenance(site, sourceSha) {
  const atlasPath = join(site, 'architecture', 'manifest.json');
  if (!existsSync(atlasPath)) return undefined;
  const atlas = JSON.parse(readPageFile(atlasPath, 'utf8'));
  const diagrams = atlas.diagrams?.filter(item => item.renderer === 'likec4');
  for (const [id, viewId] of [['system-1', LIKEC4_VIEW_ID], ['system-3', LIKEC4_OPERATIONS_VIEW_ID]]) {
    assert.ok(diagrams?.some(item => item.id === id && item.viewId === viewId), `LikeC4 ${id} view missing`);
  }
  assert.equal(atlas.sourceSha, sourceSha, 'LikeC4 Atlas source mismatch');
  const lockPath = 'scripts/architecture/package-lock.json';
  const atSource = path => execFileSync('git', ['show', `${sourceSha}:${path}`]);
  const modelDigest = sha256(atSource(LIKEC4_SOURCE_PATH));
  const lock = atSource(lockPath);
  const packageLock = JSON.parse(lock.toString('utf8'));
  const version = packageLock.packages?.['']?.dependencies?.likec4;
  assert.equal(version, LIKEC4_VERSION, 'Unexpected LikeC4 generator version');
  const lockedDependency = packageLock.packages?.['node_modules/likec4'];
  assert.equal(lockedDependency?.version, version, 'LikeC4 lock version mismatch');
  assert.match(lockedDependency?.integrity ?? '', /^sha512-/u, 'LikeC4 lock integrity missing');
  const views = new Set();
  for (const diagram of diagrams) {
    assert.equal(diagram.sourceModel, LIKEC4_SOURCE_PATH, 'LikeC4 model path mismatch');
    assert.equal(diagram.sourceModelSha256, modelDigest, 'LikeC4 model digest mismatch');
    assert.equal(diagram.artifact, LIKEC4_PUBLIC_BUNDLE, 'LikeC4 web component path mismatch');
    assert.match(diagram.viewId ?? '', /^[a-zA-Z][a-zA-Z0-9_-]*$/u, 'Invalid LikeC4 view ID');
    assert.ok(!views.has(diagram.viewId), 'Duplicate LikeC4 view ID');
    views.add(diagram.viewId);
  }
  const outputs = [LIKEC4_PUBLIC_BUNDLE, LIKEC4_PUBLIC_LICENSE].map(name => {
    const path = `architecture/${name}`;
    const content = readPageFile(join(site,path));
    assert.ok(content.length > 0, 'Empty LikeC4 publication artifact');
    return { path, sha256: sha256(content) };
  });
  return {
    sourceSha, generatedAt: new Date().toISOString(), publication: 'public',
    model: { path: LIKEC4_SOURCE_PATH, sha256: modelDigest },
    generator: { name: 'likec4', version, integrity: lockedDependency.integrity, lockPath, lockSha256: sha256(lock) },
    views: diagrams.map(({id, viewId}) => ({id, viewId})),
    outputs,
  };
}

function makeRoutes(site, sourceSha, origin, audit) {
  const snapshotBranches = [...new Set((audit.branches ?? []).map(branch => branch.sha))].filter(sha => audit.snapshots?.[sha]?.status !== 'blocked').sort();
  const reviewBranches = Object.entries(audit.reviews ?? {}).filter(([, review]) => ['ready','partial'].includes(review.status)).map(([sha]) => sha).sort();
  const uxAvailable = existsSync(join(site, 'ux', 'manifest.json'));
  const requirementsReady = existsSync(page(site, '/requirements/html/'));
  const designSearchReady = requirementsReady && existsSync(join(site, 'design-search', 'pagefind-entry.json'));
  const traceabilityReady = requirementsReady && existsSync(page(site, '/requirements/traceability/'));
  const rootLinks = ['requirements/html/',...(existsSync(page(site,'/requirements/traceability/')) ? ['requirements/traceability/'] : []),...(existsSync(page(site,'/api/')) ? ['api/'] : []),...(uxAvailable ? ['ux/'] : []),'architecture/','graph/','ci/','security/','audit/','manifest.json',
    ...snapshotBranches.flatMap(sha => [`snapshots/${sha}/`,`snapshots/${sha}/repomix.json`]), ...reviewBranches.map(sha => `reviews/${sha}/index.html`)];
  const routes = [
    { route:'/', label:'Development Portal', description:'Site map for Codexia design, code structure, CI observation and source audit.', category:'Overview', sourceSha, generationStatus:'ready', coverageStatus:'site-routes', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main/docs', internalLinks:rootLinks },
    { route:'/requirements/html/', label:'Design and requirements', description:'StrictDoc design, requirements and trace matrix.', category:'Verification', sourceSha, generationStatus:existsSync(page(site,'/requirements/html/')) ? 'ready':'unavailable', coverageStatus:'see-manifest', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main/docs/requirements', internalLinks:existsSync(page(site,'/requirements/html/')) ? ['../../','docs/requirements/REQUIREMENT-REGISTER.sdoc-TRACE.html'] : ['../../'] },
    { route:'/requirements/traceability/', label:'Traceability status', description:'Requirement conformance, obligations, reverse source inventory, exact-source observations and visible gaps for this Pages build.', category:'Verification', sourceSha, generationStatus:traceabilityReady ? 'ready':'unavailable', coverageStatus:'obligation-and-surface-status', dataKind:'build-snapshot', externalDocumentationUrl:`https://github.com/yohn-jp/codexia/tree/${sourceSha}/docs/verification/TRACEABILITY-REGISTER.sdoc`, internalLinks:traceabilityReady ? ['../../','../html/','traceability.json'] : ['../../'] },
    ...(existsSync(page(site,'/api/')) ? [{ route:'/api/', label:'API Reference', description:'Read-only TypeSpec-generated OpenAPI contract with current and target operations. Runtime verification is separate.', category:'Contracts', sourceSha, generationStatus:'ready', coverageStatus:'current-and-target-contract', dataKind:'build-snapshot', externalDocumentationUrl:`https://github.com/yohn-jp/codexia/tree/${sourceSha}/packages/http-contract/src`, internalLinks:['../','codexia.openapi.yaml','manifest.json'] }] : []),
    ...(uxAvailable ? [{ route:'/ux/', label:'UX Simulator', description:'Source-bound design and implementation projections with explicit coverage gaps.', category:'Design', sourceSha, generationStatus:'ready', coverageStatus:JSON.parse(readPageFile(join(site,'ux','manifest.json'),'utf8')).status, dataKind:'build-snapshot', externalDocumentationUrl:`https://github.com/yohn-jp/codexia/tree/${sourceSha}/docs/design/UX-SIMULATOR-CONTRACT.sdoc`, internalLinks:['../','manifest.json','snapshot.json'] }] : []),
    { route:'/architecture/', label:'Architecture Atlas', description:'Interactive LikeC4 architecture and diagrams from approved designs.', category:'Architecture', sourceSha, generationStatus: existsSync(page(site,'/architecture/')) ? 'ready':'unavailable', coverageStatus:'see-manifest', dataKind:'build-snapshot', externalDocumentationUrl:`https://github.com/yohn-jp/codexia/tree/${sourceSha}/docs`, internalLinks:['../'] },
    { route:'/graph/', label:'Code Map', description:'Static code relationships extracted by Graphify.', category:'Code', sourceSha, generationStatus: existsSync(page(site,'/graph/')) ? 'ready':'unavailable', coverageStatus:'see-graph-data', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main', internalLinks:['../','communities.html'] },
    { route:'/ci/', label:'CI Observatory', description:'Public GitHub Actions run and job observations, fetched by the browser.', category:'Verification', generationStatus: existsSync(page(site,'/ci/')) ? 'ready':'unavailable', coverageStatus:'live-public-actions-api', dataKind:'browser-live', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/actions', internalLinks:['../'] },
    { route:'/security/', label:'Code scanning export', description:'Authorized GitHub Code scanning alerts, downloadable as JSON or CSV. Findings are never published by Pages.', category:'Security', generationStatus: existsSync(page(site,'/security/')) ? 'ready':'unavailable', coverageStatus:'authorized-main-alerts', dataKind:'browser-authenticated', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/security/code-scanning', internalLinks:['../'] },
    { route:'/audit/', label:'Source Audit', description:'Repomix branch snapshots and OCR-selected review input materials. Review input is not an AI review result.', category:'Audit', generationStatus: existsSync(page(site,'/audit/')) ? 'ready':'unavailable', coverageStatus: audit.branches?.length ? 'branch-head-snapshots':'empty', dataKind:'branch-head-snapshot', observedAt:audit.observedAt, internalLinks:['../','../manifest.json'] },
    { route:'/graph/communities.html', label:'Community Overview', description:'Graphify community view.', category:'Code', sourceSha, generationStatus: existsSync(page(site,'/graph/communities.html')) ? 'ready':'unavailable', coverageStatus:'see-graph-data', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main', internalLinks:['./','../'] },
  ];
  for (const sha of snapshotBranches) {
    const snapshot=audit.snapshots[sha];
    routes.push({ route:`/snapshots/${sha}/`,label:`Source Snapshot ${sha.slice(0,12)}`,description:'Repomix source snapshot files and integrity manifest.',category:'Audit',sourceSha:sha,generationStatus:'ready',coverageStatus:snapshot.status,dataKind:'branch-head-snapshot',observedAt:audit.observedAt,externalDocumentationUrl:`https://github.com/yohn-jp/codexia/tree/${sha}`,internalLinks:[`../../audit/#sha-${sha}`,'manifest.json',...snapshot.outputs.map(item=>item.name)] });
  }
  for (const sha of reviewBranches) {
    const review=audit.reviews[sha], outputs=JSON.parse(readFileSync(join(site,'reviews',sha,'manifest.json'),'utf8')).outputs;
    routes.push({ route:`/reviews/${sha}/`,label:`Review Materials ${sha.slice(0,12)}`,description:'OCR-selected review input materials. These are not AI review findings.',category:'Audit',sourceSha:sha,generationStatus:'ready',coverageStatus:review.status,dataKind:'branch-head-snapshot',observedAt:audit.observedAt,externalDocumentationUrl:`https://github.com/yohn-jp/codexia/tree/${sha}`,internalLinks:[`../../audit/#sha-${sha}`,'manifest.json',...outputs.map(item=>item.name)] });
  }
  const likec4=likec4Provenance(site,sourceSha);
  const scalar=existsSync(join(site,'api','manifest.json')) ? JSON.parse(readPageFile(join(site,'api','manifest.json'),'utf8')) : undefined;
  assert.ok(!scalar || scalar.sourceSha===sourceSha,'Scalar API reference source mismatch');
  return { schemaVersion:1, siteOrigin:origin, sourceSha, ...(designSearchReady ? { designSearch: { version: '1.6.0', sourceSha } } : {}), generatedAt:new Date().toISOString(), ...(likec4 ? {likec4} : {}), ...(scalar ? {scalar} : {}), routes };
}

function renderPortal(manifest,audit) {
  const snapshotSet=new Set(manifest.routes.filter(x=>x.route.startsWith('/snapshots/')).map(x=>x.sourceSha));
  const reviewSet=new Set(manifest.routes.filter(x=>x.route.startsWith('/reviews/')).map(x=>x.sourceSha));
  const statusBadge=status=>`<span class="cx-pages-badge" data-state="${['ready','partial','blocked','no-diff'].includes(status)?status:'unavailable'}">${esc(status)}</span>`;
  const labels={
    'build-snapshot':'Build snapshot',
    'browser-live':'Live public data',
    'browser-authenticated':'Authorized in browser',
    'authorized-main-alerts':'Read-only GitHub API · main',
    'branch-head-snapshot':'Branch snapshots',
    'see-manifest':'Coverage in manifest',
    'see-graph-data':'Coverage in graph data',
    'current-and-target-contract':'Current and target operations',
    'live-public-actions-api':'Public Actions API',
    'branch-head-snapshots':'Observed branch heads',
  };
  const label=value=>esc(labels[value]??value);
  const cards = manifest.routes.filter(x => ['/requirements/html/','/requirements/traceability/','/api/','/architecture/','/graph/','/ux/','/ci/','/security/','/audit/'].includes(x.route)).map(item => {
    const available = item.generationStatus === 'ready';
    const target = item.route.slice(1);
    const detail=item.route==='/audit/'?`<details class="cx-pages-disclosure"><summary>${(audit.branches??[]).length} observed branches · snapshot and review status</summary><div class="cx-pages-disclosure-content"><ul class="cx-pages-branch-list">${(audit.branches??[]).map(branch=>{
      const sha=branch.sha,snapshot=audit.snapshots?.[sha],review=audit.reviews?.[sha];
      const snapLink=snapshotSet.has(sha)?`<a href="snapshots/${sha}/">Snapshot details · ${esc(sha)}</a> · <a href="snapshots/${sha}/repomix.json" download="codexia-${sha}-repomix.json">Download Snapshot JSON</a>`:`Snapshot ${esc(snapshot?.status??'unavailable')} · ${esc(sha)}`;
      const reviewStatus=review?.status??'unavailable';
      const reviewText=reviewSet.has(sha)?`<a href="reviews/${sha}/index.html">Review ${esc(review.status)}</a>`:statusBadge(reviewStatus);
      return `<li id="portal-sha-${esc(sha)}"><div class="cx-pages-branch-main"><strong>${esc(branch.branch)}</strong>${statusBadge(snapshot?.status??'unavailable')}</div><p>${snapLink}</p><p>Review materials · ${reviewText}</p></li>`;
    }).join('')}</ul><p><a class="cx-pages-action" href="manifest.json">Open audit branch manifest</a> <a class="cx-pages-action" href="audit/">Open full Source Audit</a></p></div></details>`:'';
    const community=item.route==='/graph/'?`<p><a href="graph/communities.html">Community overview</a></p>`:'';
    return `<article class="cx-pages-card"><div class="cx-pages-card-heading"><h2>${esc(item.label)}</h2>${statusBadge(available?'ready':'unavailable')}</div><p class="cx-pages-card-description">${esc(item.description)}</p><p class="cx-pages-card-meta">${label(item.dataKind)} · ${label(item.coverageStatus)}</p><div class="cx-pages-card-actions"><a class="cx-pages-action cx-pages-action--primary" href="${esc(target)}">Open ${esc(item.label)}</a></div>${community}${detail}</article>`;
  }).join('\n');
  const searchAssets = manifest.designSearch ? '<link rel="stylesheet" href="design-search/pagefind-ui.css"><script src="design-search/pagefind-ui.js" defer></script><script src="design-search/init.js" defer></script>' : '';
  const search = manifest.designSearch ? '<section aria-labelledby="design-search-title" lang="ja"><h2 id="design-search-title">設計文書検索</h2><div id="design-search"></div></section>' : '';
  const overview=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codexia Development Portal</title>${searchAssets}</head><body><main class="cx-pages-container cx-pages-main"><header class="cx-pages-hero"><h1>Codexia Development Portal</h1><p class="cx-pages-lede">Explore architecture, code relationships, UX flows, and the API contract. Check CI activity and follow the source behind each view.</p></header>${search}<section class="cx-pages-grid" aria-label="Development tools">${cards}</section><footer class="cx-pages-footer"><p class="cx-pages-source-line"><span>Pages build source SHA</span><code class="cx-pages-code">${esc(manifest.sourceSha)}</code></p><h2>Project links</h2><div class="cx-pages-actions"><a class="cx-pages-action" href="https://github.com/yohn-jp/codexia/tree/${esc(manifest.sourceSha)}/docs">GitHub Docs</a><a class="cx-pages-action" href="https://github.com/yohn-jp/codexia">Repository</a><a class="cx-pages-action" href="https://github.com/yohn-jp/codexia/actions">Actions</a></div><small>Architecture and code maps are build snapshots. CI reads public Actions data in the browser. Audit lists observed branch HEAD snapshots. Status describes generated inputs, not release certification.</small></footer></main></body></html>\n`;
  return overview;
}

function renderSnapshotLanding(sha, snapshot, branchLabels) {
  const parts=(snapshot.outputs??[]).filter(item=>item.name.startsWith('part-'));
  const full=(snapshot.outputs??[]).find(item=>item.name==='repomix.json');
  assert.ok(full,'Snapshot full export is missing');
  const status=['ready','partial'].includes(snapshot.status)?snapshot.status:'unavailable';
  const partLinks=parts.map(item=>`<li><div class="cx-pages-file-entry"><a class="cx-pages-action" href="${esc(item.name)}" download="codexia-${sha}-${esc(item.name)}">Download ${esc(item.name)}</a><span>${item.bytes} bytes${item.scope?` · ${esc(item.scope)}`:''}</span></div><span class="cx-pages-output-detail">SHA-256 <code class="cx-pages-code">${esc(item.sha256)}</code></span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Source Snapshot ${sha}</title></head><body><main class="cx-pages-container cx-pages-main"><header class="cx-pages-hero"><h1>Source Snapshot</h1><p class="cx-pages-lede">A source export from an observed branch head.</p><div class="cx-pages-meta"><span class="cx-pages-meta-label">Source SHA</span><code class="cx-pages-code">${sha}</code><span class="cx-pages-meta-label">Observed for</span><span>${branchLabels.map(esc).join(', ')||'branch HEAD'}</span><span class="cx-pages-badge" data-state="${status}">${esc(snapshot.status)}</span><span>${snapshot.fileCount} files included · ${snapshot.excludedCount} excluded</span></div><div class="cx-pages-actions"><a class="cx-pages-action cx-pages-action--primary" href="repomix.json" download="codexia-${sha}-repomix.json">Download full JSON</a><a class="cx-pages-action" href="manifest.json" download="codexia-${sha}-manifest.json">Download manifest</a><a class="cx-pages-action" href="repomix.json">View JSON</a><a class="cx-pages-action" href="../../audit/#sha-${sha}">Return to this exact SHA in Source Audit</a></div><p class="cx-pages-footnote">The manifest records file coverage, exclusions, and SHA-256 digests for each published output.</p></header><section><h2>Snapshot files</h2>${parts.length?`<details class="cx-pages-disclosure"><summary>Download snapshot parts (${parts.length})</summary><div class="cx-pages-disclosure-content"><ul class="cx-pages-output-list">${partLinks}</ul></div></details>`:'<p class="cx-pages-footnote">No split snapshot parts are available.</p>'}</section></main></body></html>\n`;
}

function generateSnapshotPages(site,audit) {
  for (const sha of [...new Set((audit.branches??[]).map(branch=>branch.sha))]) {
    assert.match(sha,SHA,'Invalid snapshot source identifier');
    const snapshot=audit.snapshots?.[sha];
    if (!snapshot || snapshot.status==='blocked') continue;
    assert.ok(['ready','partial'].includes(snapshot.status),'Invalid snapshot status');
    assert.ok(Array.isArray(snapshot.outputs),'Snapshot outputs are unavailable');
    for (const output of snapshot.outputs) assert.ok(SNAPSHOT_OUTPUT.test(output.name),'Invalid snapshot output name');
    const labels=audit.branches.filter(branch=>branch.sha===sha).map(branch=>branch.branch);
    const directory=join(site,'snapshots',sha);
    assert.ok(existsSync(directory),'Snapshot directory is missing');
    writeFileSync(join(directory,'index.html'),renderSnapshotLanding(sha,snapshot,labels));
  }
}

function renderUnavailable(item,sourceSha) {
  const local=item.route==='/graph/communities.html'?'../':item.route.split('/').filter(Boolean).length>=2?'../../':'../';
  const fallback=item.externalDocumentationUrl?`<a class="cx-pages-action" href="${esc(item.externalDocumentationUrl)}">Open the related GitHub source</a>`:'';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(item.label)} unavailable</title></head><body><main class="cx-pages-container cx-pages-main"><section class="cx-pages-empty"><h1>${esc(item.label)} unavailable</h1><p>This page was not generated for Pages build source SHA <code class="cx-pages-code">${esc(sourceSha)}</code>.</p><p>Return to the portal to open another project route.</p><div class="cx-pages-actions"><a class="cx-pages-action cx-pages-action--primary" href="${local}">Return to the Development Portal</a>${fallback}</div></section></main></body></html>\n`;
}

function inventory(site) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir,name), stat = lstatSync(absolute), rel = relative(site,absolute).split(sep).join('/');
      assert.ok(!stat.isSymbolicLink(), 'Symlink in Pages artifact');
      if (stat.isDirectory()) walk(absolute);
      else {
        assert.ok(stat.isFile(), 'Non-regular Pages artifact');
        assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519))(?:$|\/)/iu.test(rel), 'Sensitive filename in Pages artifact');
        assert.ok(!/\.(?:pem|key|p12|pfx|sqlite(?:-wal|-shm)?|db)$/iu.test(rel), 'Private or database artifact');
        files.push({ absolute, rel, bytes:stat.size });
      }
    }
  }
  walk(site);
  const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0);
  assert.ok(totalBytes<=MAX_SITE_BYTES,`Pages artifact exceeds the 900 MiB publication budget (${totalBytes} bytes)`);
  return files;
}

function inspectSecrets(files) {
  for (const file of files) {
    const bytes = readPageFile(file.absolute);
    if (bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    assert.ok(!containsCredentialPattern(content), `Credential-like value in public artifact: ${file.rel}`);
  }
}

function localTarget(site, htmlPath, href, origin) {
  if (!href || /^(?:mailto:|tel:|data:|javascript:)/iu.test(href)) return null;
  const pageRel = relative(site, htmlPath).split(sep).join('/');
  const pageDir = pageRel;
  let targetUrl;
  try { targetUrl=new URL(href,origin+'/'+pageDir); }
  catch { throw new Error('Invalid local HTML link'); }
  if (targetUrl.origin !== new URL(origin).origin) return null;
  const prefix = new URL(origin + '/').pathname;
  assert.ok(targetUrl.pathname.startsWith(prefix),'Same-origin link escapes the project base path');
  let relPath = decodeURIComponent(targetUrl.pathname.slice(prefix.length));
  if (!relPath || targetUrl.pathname.endsWith('/')) relPath += 'index.html';
  const normalized = resolve(site, relPath);
  assert.ok(normalized === site || normalized.startsWith(site + sep),'Link escapes the Pages artifact');
  return { path:normalized, fragment:targetUrl.hash ? decodeURIComponent(targetUrl.hash.slice(1)) : '' };
}

function allowedOutputs(outputs,allowed) {
  assert.ok(Array.isArray(outputs),'Output manifest missing');
  const names=new Set();
  for (const output of outputs) {
    assert.ok(output && typeof output==='object' && typeof output.name==='string' && output.name===output.name.split(/[\\/]/u).at(-1) && allowed(output.name),'Invalid declared output');
    assert.ok(!names.has(output.name),'Duplicate declared output');
    assert.ok(Number.isSafeInteger(output.bytes) && output.bytes>=0 && /^[a-f0-9]{64}$/u.test(output.sha256),'Invalid output integrity record');
    names.add(output.name);
  }
  return names;
}

function verifyOutputs(directory,outputs,allowed,extra=[]) {
  const names=allowedOutputs(outputs,allowed);
  assert.ok(names.size>0,'No declared outputs');
  for (const output of outputs) {
    const bytes=readPageFile(join(directory,output.name),undefined,'Output is not a regular file');
    assert.equal(bytes.length,output.bytes,'Output size mismatch');
    assert.equal(sha256(bytes),output.sha256,'Output digest mismatch');
  }
  const actual=readdirSync(directory).sort();
  const expected=[...names,'manifest.json',...extra].sort();
  assert.ok(JSON.stringify(actual)===JSON.stringify(expected),'Undeclared output in SHA directory');
  return names;
}

function assertFragment(target) {
  if (!target.fragment) return;
  const content=readFileSync(target.path,'utf8');
  const fragment=target.fragment.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
  assert.ok(new RegExp(`(?:\\bid|\\bname)\\s*=\\s*(["'])${fragment}\\1`,'u').test(content),'Internal HTML fragment target is missing');
}

export function generate(siteDir, sourceSha, originValue) {
  const site = resolve(siteDir), origin = canonicalOrigin(originValue);
  assert.ok(SHA.test(sourceSha),'Expected exact 40-character source SHA');
  assert.ok(awaitGitHead()===sourceSha,'Source SHA does not match the exact checked-out commit');
  assert.ok(existsSync(join(site,'manifest.json')), 'Audit branch manifest is required');
  const auditIndex = join(site,'audit','index.html');
  assert.ok(existsSync(auditIndex), 'Audit exporter must write /audit/index.html before portal generation');
  const audit=JSON.parse(readFileSync(join(site,'manifest.json'),'utf8'));
  generateSnapshotPages(site,audit);
  const manifest = makeRoutes(site,sourceSha,origin,audit);
  assert.equal(manifest.routes.find(x=>x.route==='/audit/').generationStatus,'ready');
  for (const item of manifest.routes) {
    if (item.generationStatus==='ready') continue;
    const output=page(site,item.route);
    mkdirSync(resolve(output,'..'),{recursive:true});
    writeFileSync(output,renderUnavailable(item,sourceSha));
  }
  writeFileSync(join(site,'index.html'),renderPortal(manifest,audit));
  writeFileSync(join(site,'sitemap.json'),json(manifest.routes.map(({route,label,description,category})=>({route,label,description,category}))));
  writeFileSync(join(site,'site-manifest.json'),json(manifest));
  return manifest;
}

function awaitGitHead() {
  return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
}

function shaDirectories(site,kind,expectedShas) {
  const root=join(site,kind), expected=[...expectedShas].sort();
  if (!existsSync(root)) { assert.equal(expected.length,0,'Expected SHA directories are missing'); return; }
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(),'Invalid SHA artifact directory');
  assert.ok(JSON.stringify(readdirSync(root).sort())===JSON.stringify(expected),'Undeclared SHA artifact directory');
}

function verifyAuditArtifacts(site,audit) {
  assert.ok(Array.isArray(audit.branches) && audit.snapshots && typeof audit.snapshots==='object','Invalid audit manifest');
  const branchShas=new Set();
  for (const branch of audit.branches) {
    assert.ok(branch && typeof branch.branch==='string' && SHA.test(branch.sha),'Invalid branch record');
    branchShas.add(branch.sha);
  }
  const snapshotShas=Object.keys(audit.snapshots).sort();
  assert.deepEqual(snapshotShas,[...branchShas].sort(),'Snapshot registry does not match observed branches');
  const readySnapshots=[];
  for (const sha of snapshotShas) {
    const item=audit.snapshots[sha];
    assert.ok(['ready','partial','blocked'].includes(item.status),'Invalid snapshot status');
    const directory=join(site,'snapshots',sha);
    if (item.status==='blocked') {
      assert.ok(!existsSync(directory),'Blocked snapshot has published files');
      continue;
    }
    readySnapshots.push(sha);
    const nestedPath=join(directory,'manifest.json'), nested=JSON.parse(readFileSync(nestedPath,'utf8'));
    assert.ok(nested.sourceSha===sha && nested.status===item.status,'Snapshot metadata disagrees with site registry');
    assert.ok(item.fileCount===nested.files?.length && item.excludedCount===nested.excluded?.length,'Snapshot coverage counts disagree');
    assert.ok(sha256(JSON.stringify(item.outputs))===sha256(JSON.stringify(nested.outputs)),'Snapshot output registries disagree');
    const names=verifyOutputs(directory,nested.outputs,name=>SNAPSHOT_OUTPUT.test(name),['index.html']);
    assert.ok(names.has('repomix.json'),'Snapshot full export is missing');
    const full=JSON.parse(readFileSync(join(directory,'repomix.json'),'utf8'));
    assert.ok(full.audit?.sourceSha===sha && full.audit?.status===nested.status,'Full source export identity disagrees');
    assert.ok(Object.keys(full.files??{}).length===nested.files.length,'Full source export coverage disagrees');
  }
  shaDirectories(site,'snapshots',readySnapshots);

  const reviews=audit.reviews??{};
  assert.ok(reviews && typeof reviews==='object' && !Array.isArray(reviews),'Invalid review registry');
  const readyReviews=[];
  for (const [sha,review] of Object.entries(reviews).sort(([a],[b])=>a.localeCompare(b))) {
    assert.ok(SHA.test(sha) && branchShas.has(sha),'Review references an unobserved source');
    assert.ok(['ready','partial','blocked','no-diff'].includes(review.status),'Invalid review status');
    const directory=join(site,'reviews',sha);
    if (!['ready','partial'].includes(review.status)) {
      assert.ok(!existsSync(directory),'Unavailable review has published files');
      continue;
    }
    readyReviews.push(sha);
    const nested=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
    assert.ok(nested.sourceSha===sha && nested.status===review.status,'Review metadata disagrees with site registry');
    assert.ok(nested.published===review.published && nested.omitted===review.omitted,'Review coverage counts disagree');
    verifyOutputs(directory,nested.outputs,name=>REVIEW_OUTPUTS.has(name));
  }
  shaDirectories(site,'reviews',readyReviews);
  return { readySnapshots, readyReviews };
}

function validateRegistry(site,manifest,audit,origin) {
  const base=['/','/requirements/html/','/requirements/traceability/',...(existsSync(page(site,'/api/'))?['/api/']:[]),...(existsSync(join(site,'ux','manifest.json'))?['/ux/']:[]),'/architecture/','/graph/','/ci/','/security/','/audit/','/graph/communities.html'];
  const snapshotRoutes=Object.keys(audit.snapshots).filter(sha=>audit.snapshots[sha].status!=='blocked').sort().map(sha=>`/snapshots/${sha}/`);
  const reviewRoutes=Object.entries(audit.reviews??{}).filter(([,review])=>['ready','partial'].includes(review.status)).map(([sha])=>sha).sort().map(sha=>`/reviews/${sha}/`);
  const expected=[...base,...snapshotRoutes,...reviewRoutes];
  assert.ok(Array.isArray(manifest.routes),'Site route registry is missing');
  assert.ok(JSON.stringify(manifest.routes.map(item=>item.route))===JSON.stringify(expected),'Site route registry does not match generated pages');
  assert.ok(new Set(manifest.routes.map(item=>item.route)).size===manifest.routes.length,'Duplicate site route');
  assert.ok(manifest.routes.every(item=>item.siteOrigin===undefined || item.siteOrigin===origin),'Route origin mismatch');
  const sitemapPath=join(site,'sitemap.json'), sitemap=JSON.parse(readFileSync(sitemapPath,'utf8'));
  const projection=manifest.routes.map(({route,label,description,category})=>({route,label,description,category}));
  assert.ok(sha256(JSON.stringify(sitemap))===sha256(JSON.stringify(projection)),'Sitemap does not match site registry');
  const sourceSha=manifest.sourceSha;
  for (const item of manifest.routes) {
    assert.ok(typeof item.label==='string' && typeof item.description==='string' && typeof item.category==='string','Invalid route metadata');
    assert.ok(['ready','unavailable'].includes(item.generationStatus),'Invalid route generation status');
    const sourceIsIndependent=['/ci/','/audit/','/security/'].includes(item.route);
    if (sourceIsIndependent) assert.ok(item.sourceSha===undefined,'Live or aggregate route was assigned a misleading source SHA');
    else assert.ok(typeof item.sourceSha==='string' && SHA.test(item.sourceSha),'Invalid route source SHA');
    const target=page(site,item.route);
    assert.ok(existsSync(target),'Registered route is missing');
    if (item.generationStatus==='unavailable') {
      const html=readFileSync(target,'utf8');
      assert.ok(html.includes('unavailable') && html.includes(sourceSha),'Unavailable route has no generated fallback page');
      assert.ok(item.externalDocumentationUrl,'Unavailable route has no source fallback');
    }
    assert.ok(Array.isArray(item.internalLinks),'Route internal-link inventory missing');
    const isShaPage=item.route.startsWith('/snapshots/') || item.route.startsWith('/reviews/');
    if (!isShaPage && !sourceIsIndependent) assert.ok(item.sourceSha===sourceSha,'Static route source SHA differs from Pages build');
    if (item.externalDocumentationUrl) {
      let url;
      try { url=new URL(item.externalDocumentationUrl); }
      catch { throw new Error('Invalid GitHub source fallback'); }
      assert.ok(url.protocol==='https:' && url.hostname==='github.com' && url.pathname.startsWith('/yohn-jp/codexia'),'Invalid GitHub source fallback');
    }
    for (const link of item.internalLinks) {
      const local=localTarget(site,target,link,origin);
      assert.ok(local && existsSync(local.path),'Registered internal link is missing');
      assertFragment(local);
    }
  }
  const requirements=manifest.routes.find(item=>item.route==='/requirements/html/');
  if (requirements.generationStatus === 'ready') verifySpecifications(site, sourceSha);
  const traceability=manifest.routes.find(item=>item.route==='/requirements/traceability/');
  if (traceability.generationStatus==='ready') {
    const trace=JSON.parse(readPageFile(join(site,'requirements','traceability','traceability.json'),'utf8','Requirements traceability JSON is missing'));
    assert.equal(trace.schemaVersion,1,'Requirements traceability schema version mismatch');
    assert.equal(trace.sourceSha,sourceSha,'Requirements traceability source mismatch');
    assert.ok(Array.isArray(trace.requirements) && Array.isArray(trace.obligations) && Array.isArray(trace.reverseTrace),'Requirements traceability projection is incomplete');
    const requirementsManifest=verifySpecifications(site,sourceSha);
    const expectedQualification={status:'PENDING_PAGES_PUBLISH',sourceSha,publisher:'.github/workflows/repository-audit.yml',strictDocStaticStaging:'PASSED',strictDocBrowserAcceptance:'PASSED',publicUrlConfirmation:'PENDING',publisherExecution:trace.execution,detail:'Staging checks passed; this exact source SHA still requires public Pages URL confirmation.'};
    assert.deepEqual(trace.pagesQualification,expectedQualification,'Traceability TRC-07 qualification is missing, stale, or foreign');
    assert.deepEqual(requirementsManifest.pagesQualification,expectedQualification,'Requirements manifest TRC-07 qualification differs from public trace JSON');
    assert.ok(trace.verificationReceipt && trace.verificationReceipt.sourceSha === sourceSha && ['CERTIFIED','NOT_AVAILABLE'].includes(trace.verificationReceipt.status),'Verify artifact receipt is missing or source-mismatched');
    assert.deepEqual(requirementsManifest.verificationReceipt,trace.verificationReceipt,'Verify artifact receipt differs between trace JSON and requirements manifest');
    assert.deepEqual(requirementsManifest.qualificationGates,trace.qualificationGates,'Qualification gate projection differs between trace JSON and requirements manifest');
    assert.deepEqual(Object.keys(trace.qualificationGates??{}).sort(),['G0','G1','G2','G3','G4','G5','G6','G7'],'Qualification gates G0-G7 are incomplete');
  }
  const apiRoute=manifest.routes.find(item=>item.route==='/api/');
  if (apiRoute) {
    assert.equal(apiRoute.generationStatus,'ready','API reference generation must be complete before publication');
    assert.equal(apiRoute.sourceSha,sourceSha,'API reference route source SHA differs from Pages build');
    const apiManifest=verifyScalar(site,sourceSha);
    assert.deepEqual(manifest.scalar,apiManifest,'Top-level Scalar provenance differs from API artifact manifest');
  } else assert.equal(manifest.scalar,undefined,'Scalar provenance exists without a registered route');
  const uxRoute=manifest.routes.find(item=>item.route==='/ux/');
  if (uxRoute) {
    assert.equal(uxRoute.generationStatus,'ready','UX projections must be generated before Pages publication');
    assert.equal(uxRoute.sourceSha,sourceSha,'UX route source differs from Pages build');
    const ux=inspectUxArtifact(join(site,'ux'),{expectedSourceSha:sourceSha});
    assert.equal(uxRoute.coverageStatus,ux.manifest.status,'UX route status differs from its manifest');
    assert.equal(uxRoute.externalDocumentationUrl,`https://github.com/yohn-jp/codexia/tree/${sourceSha}/docs/design/UX-SIMULATOR-CONTRACT.sdoc`,'UX source link must use the exact Pages source SHA');
  } else assert.equal(existsSync(join(site,'ux','manifest.json')),false,'UX artifact exists without a registered route');
  const architecture=manifest.routes.find(item=>item.route==='/architecture/');
  if (architecture.generationStatus==='ready') {
    const atlas=JSON.parse(readPageFile(join(site,'architecture','manifest.json'),'utf8'));
    assert.ok(atlas.sourceSha===sourceSha,'Architecture source SHA differs from Pages build');
    const expectedLikec4=likec4Provenance(site,sourceSha);
    if (expectedLikec4) {
      assert.ok(manifest.likec4, 'LikeC4 publication provenance missing');
      const {generatedAt:ignored, ...expected}=expectedLikec4;
      const {generatedAt, ...recorded}=manifest.likec4;
      assert.ok(!Number.isNaN(Date.parse(generatedAt)), 'LikeC4 generation time invalid');
      assert.deepEqual(recorded,expected,'LikeC4 publication digest or provenance mismatch');
    } else assert.equal(manifest.likec4,undefined,'LikeC4 provenance has no published view');
    assert.ok(Array.isArray(atlas.diagrams) && atlas.diagrams.length>0,'Architecture diagram manifest is empty');
    const images=[];
    const diagramIds=[];
    for (const diagram of atlas.diagrams) {
      assert.ok(diagram && typeof diagram.id==='string' && /^[a-z]+-\d+$/u.test(diagram.id),'Invalid Architecture diagram identity');
      assert.ok(!diagramIds.includes(diagram.id),'Duplicate Architecture diagram identity');
      diagramIds.push(diagram.id);
      assert.ok(['likec4','mermaid'].includes(diagram.renderer),'Invalid Architecture diagram renderer');
      if (diagram.renderer === 'likec4') {
        assert.equal(diagram.image,undefined,'Native LikeC4 view must not point to an SVG');
        continue;
      }
      assert.ok(typeof diagram.image==='string' && /^svg\/[a-z]+-\d+\.svg$/u.test(diagram.image) && diagram.image===`svg/${diagram.id}.svg`,'Invalid Architecture SVG path');
      assert.ok(!images.includes(diagram.image),'Duplicate Architecture SVG path');
      images.push(diagram.image);
      const svg=readPageFile(join(site,'architecture',diagram.image),'utf8','Architecture SVG asset is missing or not a regular file');
      assert.ok(/<svg(?:\s|>)/u.test(svg.slice(0,2048)) && /<\/svg>/u.test(svg.slice(-2048)),'Invalid Architecture SVG asset');
    }
    const architectureEntries=readdirSync(join(site,'architecture')).sort();
    assert.deepEqual(architectureEntries,['atlas.css','atlas.js','index.html','likec4','manifest.json','svg'],'Unexpected Architecture build output');
    assert.deepEqual(readdirSync(join(site,'architecture','likec4')).sort(),
      [LIKEC4_PUBLIC_BUNDLE, LIKEC4_PUBLIC_LICENSE].map(name => name.split('/').at(-1)).sort(),
      'Unexpected LikeC4 build output');
    assert.ok(JSON.stringify(readdirSync(join(site,'architecture','svg')).sort())===JSON.stringify(images.map(image=>image.slice(4)).sort()),'Architecture SVG directory differs from manifest');
  }
  const graphRoute=manifest.routes.find(item=>item.route==='/graph/');
  if (graphRoute.generationStatus==='ready') {
    const graph=JSON.parse(readFileSync(join(site,'graph','source.json'),'utf8'));
    assert.ok(graph.sourceSha===sourceSha,'Graph source SHA differs from Pages build');
    assert.deepEqual(readdirSync(join(site,'graph')).sort(),['analysis.mjs','communities.html','index.html','source.json'],'Unexpected Graph build output');
  }
  const securityRoute=manifest.routes.find(item=>item.route==='/security/');
  assert.ok(securityRoute.generationStatus==='ready' && securityRoute.sourceSha===undefined &&
    securityRoute.dataKind==='browser-authenticated','Security export must not claim a source snapshot');
  const securityDir=join(site,'security');
  assert.deepEqual(readdirSync(securityDir).sort(),['api.mjs','app.mjs','index.html','security.css'],'Unexpected Security export artifact');
  const securityHtml=readPageFile(join(securityDir,'index.html'),'utf8');
  assert.ok(securityHtml.includes('Content-Security-Policy') && securityHtml.includes('connect-src https://api.github.com'),'Security export CSP is required');
  const auditRoute=manifest.routes.find(item=>item.route==='/audit/');
  assert.ok(auditRoute.generationStatus==='ready' && auditRoute.sourceSha===undefined && auditRoute.observedAt===audit.observedAt,'Source Audit route does not preserve branch observation provenance');
  for (const sha of snapshotRoutes.map(route=>route.split('/')[2])) {
    const item=manifest.routes.find(route=>route.route===`/snapshots/${sha}/`);
    assert.ok(item.sourceSha===sha && item.coverageStatus===audit.snapshots[sha].status && item.dataKind==='branch-head-snapshot','Snapshot route metadata disagrees with its SHA manifest');
  }
  for (const sha of reviewRoutes.map(route=>route.split('/')[2])) {
    const item=manifest.routes.find(route=>route.route===`/reviews/${sha}/`);
    assert.ok(item.sourceSha===sha && item.coverageStatus===audit.reviews[sha].status && item.dataKind==='branch-head-snapshot','Review route metadata disagrees with its SHA manifest');
  }
}

function verifyScalar(site,sourceSha) {
  const directory=join(site,'api'), manifestPath=join(directory,'manifest.json');
  const manifest=JSON.parse(readPageFile(manifestPath,'utf8','Scalar artifact manifest is missing'));
  assert.equal(manifest.schemaVersion,1,'Unexpected Scalar artifact manifest version');
  assert.equal(manifest.sourceSha,sourceSha,'Scalar artifact source SHA mismatch');
  assert.equal(manifest.publication,'public-static-contract','Scalar artifact publication classification mismatch');
  assert.deepEqual(manifest.targetState,{contract:'generated-target',runtime:'partial-generated-route-registration',verification:'not-asserted-by-this-page'},'Scalar target/runtime/verification state must remain explicit');
  assert.equal(manifest.input?.path,'packages/http-contract/openapi/codexia.openapi.yaml','Scalar input path mismatch');
  const source=readApprovedOpenapi(process.cwd(),sourceSha);
  const routes=execFileSync('git',['show',`${sourceSha}:packages/http-contract/test/fixtures/admitted-routes.json`]);
  const contractPackageBytes=execFileSync('git',['show',`${sourceSha}:packages/http-contract/package.json`]);
  const pnpmLock=execFileSync('git',['show',`${sourceSha}:pnpm-lock.yaml`]);
  const lock=execFileSync('git',['show',`${sourceSha}:scripts/pages-api/package-lock.json`]);
  const admitted=JSON.parse(routes.toString('utf8'));
  const routeStates=Object.fromEntries([
    ...admitted.current.map(value=>[value.slice(0,value.indexOf(' ')).toLowerCase()+' '+value.slice(value.indexOf(' ')+1), 'current']),
    ...admitted.target.map(value=>[value.slice(0,value.indexOf(' ')).toLowerCase()+' '+value.slice(value.indexOf(' ')+1), 'target']),
  ]);
  assert.equal(manifest.routeInventory?.path,'packages/http-contract/test/fixtures/admitted-routes.json','Scalar admitted-route source path mismatch');
  assert.equal(manifest.routeInventory?.sha256,sha256(routes),'Scalar admitted-route source digest mismatch');
  assert.equal(manifest.routeInventory?.currentCount,admitted.current.length,'Scalar current route count mismatch');
  assert.equal(manifest.routeInventory?.targetCount,admitted.target.length,'Scalar target route count mismatch');
  assert.deepEqual(manifest.routeInventory?.operationStates,Object.fromEntries(Object.entries(routeStates).sort(([a],[b])=>a.localeCompare(b))), 'Scalar per-operation route states differ from the admitted inventory');
  assert.equal(manifest.typeSpec?.packagePath,'packages/http-contract/package.json','TypeSpec package path mismatch');
  assert.equal(manifest.typeSpec?.packageSha256,sha256(contractPackageBytes),'TypeSpec package digest mismatch');
  assert.equal(manifest.typeSpec?.lockPath,'pnpm-lock.yaml','TypeSpec lock path mismatch');
  assert.equal(manifest.typeSpec?.lockSha256,sha256(pnpmLock),'TypeSpec lock digest mismatch');
  const contractPackage=JSON.parse(contractPackageBytes.toString('utf8'));
  const expectedTypeSpecVersions=Object.fromEntries(['@typespec/compiler','@typespec/http','@typespec/openapi','@typespec/openapi3'].map(name=>[name,contractPackage.devDependencies?.[name]]));
  assert.deepEqual(manifest.typeSpec?.versions,expectedTypeSpecVersions,'Scalar TypeSpec versions differ from the source package');
  for (const [name,version] of Object.entries(expectedTypeSpecVersions)) assert.ok(pnpmLock.toString('utf8').includes(`'${name}@${version}'`),`TypeSpec lock is missing ${name}@${version}`);
  const lockData=JSON.parse(lock.toString('utf8'));
  const scalarPackage=lockData.packages?.['node_modules/@scalar/api-reference'];
  assert.equal(scalarPackage?.version,'1.83.0','Scalar lock version mismatch');
  assert.equal(manifest.generator?.name,'@scalar/api-reference','Scalar generator identity mismatch');
  assert.equal(manifest.generator?.version,'1.83.0','Scalar generator version mismatch');
  assert.equal(manifest.generator?.npmIntegrity,scalarPackage.integrity,'Scalar package integrity mismatch');
  assert.equal(manifest.generator?.lockPath,'scripts/pages-api/package-lock.json','Scalar lock path mismatch');
  assert.equal(manifest.generator?.lockSha256,sha256(lock),'Scalar lock digest mismatch');
  assert.equal(manifest.input?.sha256,sha256(source),'Scalar source contract digest mismatch');
  assert.ok(manifest.buildTool?.name==='esbuild' && manifest.buildTool?.version===lockData.packages?.['node_modules/esbuild']?.version,'Scalar bundler does not match lockfile');
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)),'Scalar generation timestamp is invalid');
  assert.deepEqual(readdirSync(directory).sort(),['THIRD_PARTY_NOTICES.txt','codexia.openapi.yaml','index.html','manifest.json','scalar-reference.css','scalar-reference.js'],'Unexpected Scalar artifact output');
  const names=verifyOutputs(directory,manifest.outputs,name=>['THIRD_PARTY_NOTICES.txt','codexia.openapi.yaml','index.html','scalar-reference.css','scalar-reference.js'].includes(name));
  assert.deepEqual([...names].sort(),['THIRD_PARTY_NOTICES.txt','codexia.openapi.yaml','index.html','scalar-reference.css','scalar-reference.js'],'Scalar output registry mismatch');
  assert.match(readPageFile(join(directory,'THIRD_PARTY_NOTICES.txt'),'utf8'),/Copyright Scalar[\s\S]*MIT License/u,'Scalar license notice is missing');
  assert.match(readPageFile(join(directory,'scalar-reference.js'),'utf8'),/@license\s+MIT/u,'Upstream bundled legal comments are missing');
  const yaml=readPageFile(join(directory,'codexia.openapi.yaml'),'utf8');
  assert.ok(yaml.includes('openapi: 3.1.0'),'Scalar output is not OpenAPI 3.1');
  assert.equal(manifest.input?.outputSha256,sha256(Buffer.from(yaml)),'Scalar sanitized OpenAPI output digest mismatch');
  assert.doesNotMatch(yaml,/^\s*servers:\s*$/mu,'Scalar output contains a root/path/operation server declaration');
  assert.doesNotMatch(yaml,/^\s*\$ref:\s*https?:/mu,'Scalar output contains an external schema reference');
  assert.ok((yaml.match(/^\s*x-codexia-pages-status:/gmu)??[]).length===admitted.current.length+admitted.target.length,'Per-operation status annotations are incomplete');
  const html=readPageFile(join(directory,'index.html'),'utf8');
  assert.ok(html.includes("connect-src 'self'"),'Scalar CSP must prohibit external fetches');
  assert.ok(html.includes('OpenAPI 3.1 contract generated from TypeSpec') && html.includes('current admitted operations register in Fastify'),'Scalar page must distinguish contract from implementation');
  assert.ok(html.includes('Authentication examples are removed') && html.includes('No API server, credential entry, or Try It request'),'Scalar publication boundary notice missing');
  assert.ok(html.includes('Authentication scheme definitions') && html.includes('ApiKeyAuth'),'Read-only authentication scheme details missing');
  return manifest;
}

export function finalize(siteDir,originValue) {
  const site=resolve(siteDir), origin=canonicalOrigin(originValue);
  const top=JSON.parse(readFileSync(join(site,'manifest.json'),'utf8'));
  const registry=JSON.parse(readFileSync(join(site,'site-manifest.json'),'utf8'));
  assert.ok(registry.siteOrigin===origin,'Site registry origin mismatch');
  const allowedShas=Object.entries(top.reviews??{}).filter(([,review])=>['ready','partial'].includes(review.status)).map(([sha])=>sha);
  for (const sha of allowedShas) {
    assert.ok(SHA.test(sha),'Invalid review source identifier');
    const reviewsRoot=join(site,'reviews');
    const folder=join(reviewsRoot,sha), manifestPath=join(folder,'manifest.json');
    assert.ok(lstatSync(reviewsRoot).isDirectory(),'Review root is not a regular directory');
    assert.ok(lstatSync(folder).isDirectory(),'Review SHA directory is not a regular directory');
    const detail=JSON.parse(readPageFile(manifestPath,'utf8','Review manifest is not a regular file'));
    assert.ok(detail.sourceSha===sha && detail.status===top.reviews[sha].status,'Review manifest identity mismatch');
    const names=allowedOutputs(detail.outputs,name=>REVIEW_OUTPUTS.has(name));
    assert.ok(names.has('index.html'),'Review index output is not declared');
    const bytes=readPageFile(join(folder,'index.html'),undefined,'Review index is not a regular file');
    const record=detail.outputs.find(output=>output.name==='index.html');
    record.bytes=bytes.length; record.sha256=sha256(bytes);
    const staging=mkdtempSync(join(folder,'.review-manifest-'));
    try {
      const temporary=join(staging,'manifest.json');
      writeFileSync(temporary,json(detail),{flag:'wx'});
      renameSync(temporary,manifestPath);
    } finally {
      rmSync(staging,{recursive:true,force:true});
    }
  }
  return { finalizedReviews:allowedShas.length };
}

export function verify(siteDir, originValue) {
  const site = resolve(siteDir), origin = canonicalOrigin(originValue);
  assert.ok(existsSync(site) && lstatSync(site).isDirectory(), 'Pages artifact directory required');
  const files = inventory(site);
  inspectSecrets(files);
  const manifestPath = join(site,'site-manifest.json');
  assert.ok(existsSync(manifestPath), 'Site manifest missing');
  const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.ok(manifest.siteOrigin===origin && typeof manifest.sourceSha==='string' && SHA.test(manifest.sourceSha),'Invalid site manifest identity');
  const audit = JSON.parse(readFileSync(join(site,'manifest.json'),'utf8'));
  verifyAuditArtifacts(site,audit);
  validateRegistry(site,manifest,audit,origin);
  for (const {absolute,rel} of files) {
    if (!/\.html?$/iu.test(rel)) continue;
    const html=readFileSync(absolute,'utf8');
    for (const match of html.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/giu)) {
      const target=localTarget(site,absolute,match[2],origin);
      if (target) {
        assert.ok(existsSync(target.path),`Broken internal link in generated HTML: ${rel} ${match[2]}`);
        assertFragment(target);
      }
    }
  }
  return { files:files.length,routes:manifest.routes.length,sourceSha:manifest.sourceSha };
}

if (process.argv[1] && resolve(process.argv[1])===self) {
  try {
    const [command,...args]=process.argv.slice(2);
    if (command==='generate' && args.length===3) console.log(JSON.stringify(generate(args[0],args[1],args[2])));
    else if (command==='finalize' && args.length===2) console.log(JSON.stringify(finalize(args[0],args[1])));
    else if (command==='verify' && args.length===2) console.log(JSON.stringify(verify(args[0],args[1])));
    else throw new Error('Usage: node scripts/audit/portal.mjs generate SITE SOURCE_SHA ORIGIN | finalize SITE ORIGIN | verify SITE ORIGIN');
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
