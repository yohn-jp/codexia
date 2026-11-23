#!/usr/bin/env node
// Build and verify the public, static Pages entry point and site registry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsCredentialPattern } from './publication-policy.mjs';

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

function makeRoutes(site, sourceSha, origin, audit) {
  const snapshotBranches = [...new Set((audit.branches ?? []).map(branch => branch.sha))].filter(sha => audit.snapshots?.[sha]?.status !== 'blocked').sort();
  const reviewBranches = Object.entries(audit.reviews ?? {}).filter(([, review]) => ['ready','partial'].includes(review.status)).map(([sha]) => sha).sort();
  const rootLinks = ['architecture/','graph/','ci/','security/','audit/','manifest.json',
    ...snapshotBranches.flatMap(sha => [`snapshots/${sha}/`,`snapshots/${sha}/repomix.json`]), ...reviewBranches.map(sha => `reviews/${sha}/index.html`)];
  const routes = [
    { route:'/', label:'Development Portal', description:'Site map for Codexia design, code structure, CI observation and source audit.', category:'Overview', sourceSha, generationStatus:'ready', coverageStatus:'site-routes', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main/docs', internalLinks:rootLinks },
    { route:'/architecture/', label:'Architecture Atlas', description:'Rendered views of canonical Mermaid design documents.', category:'Architecture', sourceSha, generationStatus: existsSync(page(site,'/architecture/')) ? 'ready':'unavailable', coverageStatus:'see-manifest', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main/docs', internalLinks:['../'] },
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
  return { schemaVersion:1, siteOrigin:origin, sourceSha, generatedAt:new Date().toISOString(), routes };
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
    'live-public-actions-api':'Public Actions API',
    'branch-head-snapshots':'Observed branch heads',
  };
  const label=value=>esc(labels[value]??value);
  const cards = manifest.routes.filter(x => ['/architecture/','/graph/','/ci/','/security/','/audit/'].includes(x.route)).map(item => {
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
  const overview=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codexia Development Portal</title></head><body><main class="cx-pages-container cx-pages-main"><header class="cx-pages-hero"><h1>Codexia Development Portal</h1><p class="cx-pages-lede">Explore the project’s architecture, code relationships, CI activity, security exports, and branch source snapshots.</p></header><section class="cx-pages-grid" aria-label="Development tools">${cards}</section><footer class="cx-pages-footer"><p class="cx-pages-source-line"><span>Pages build source SHA</span><code class="cx-pages-code">${esc(manifest.sourceSha)}</code></p><h2>Project links</h2><div class="cx-pages-actions"><a class="cx-pages-action" href="https://github.com/yohn-jp/codexia/tree/main/docs">GitHub Docs</a><a class="cx-pages-action" href="https://github.com/yohn-jp/codexia">Repository</a><a class="cx-pages-action" href="https://github.com/yohn-jp/codexia/actions">Actions</a></div><small>Architecture and code maps are build snapshots. CI reads public Actions data in the browser. Audit lists observed branch HEAD snapshots. Status describes generated inputs, not release certification.</small></footer></main></body></html>\n`;
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
  const local=item.route==='/graph/communities.html'?'../':item.route.split('/').filter(Boolean).length>2?'../../':'../';
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
  const pageDir = pageRel.includes('/') ? pageRel.slice(0,pageRel.lastIndexOf('/')+1) : '';
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
  const base=['/','/architecture/','/graph/','/ci/','/security/','/audit/','/graph/communities.html'];
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
  const architecture=manifest.routes.find(item=>item.route==='/architecture/');
  if (architecture.generationStatus==='ready') {
    const atlas=JSON.parse(readFileSync(join(site,'architecture','manifest.json'),'utf8'));
    assert.ok(atlas.sourceSha===sourceSha,'Architecture source SHA differs from Pages build');
    assert.ok(Array.isArray(atlas.diagrams) && atlas.diagrams.length>0,'Architecture diagram manifest is empty');
    const images=[];
    const diagramIds=[];
    for (const diagram of atlas.diagrams) {
      assert.ok(diagram && typeof diagram.id==='string' && /^[a-z]+-\d+$/u.test(diagram.id),'Invalid Architecture diagram identity');
      assert.ok(!diagramIds.includes(diagram.id),'Duplicate Architecture diagram identity');
      diagramIds.push(diagram.id);
      assert.ok(typeof diagram.image==='string' && /^svg\/[a-z]+-\d+\.svg$/u.test(diagram.image) && diagram.image===`svg/${diagram.id}.svg`,'Invalid Architecture SVG path');
      assert.ok(!images.includes(diagram.image),'Duplicate Architecture SVG path');
      images.push(diagram.image);
      const svg=readPageFile(join(site,'architecture',diagram.image),'utf8','Architecture SVG asset is missing or not a regular file');
      assert.ok(/<svg(?:\s|>)/u.test(svg.slice(0,2048)) && /<\/svg>/u.test(svg.slice(-2048)),'Invalid Architecture SVG asset');
    }
    const architectureEntries=readdirSync(join(site,'architecture')).sort();
    assert.ok(JSON.stringify(architectureEntries)===JSON.stringify(['atlas.css','atlas.js','index.html','manifest.json','svg']),'Unexpected Architecture build output');
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
        assert.ok(existsSync(target.path),'Broken internal link in generated HTML');
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
