#!/usr/bin/env node
// Build and verify the public, static Pages entry point and site registry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const CANONICAL_ORIGIN = 'https://yohn-jp.github.io/codexia';
const MAX_SITE_BYTES = 900 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const esc = value => String(value).replace(/[&<>"']/gu, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

function canonicalOrigin(value) {
  assert.equal(value, CANONICAL_ORIGIN, 'Pages origin must be the canonical public repository site');
  return value;
}

function page(site, route) {
  const path = route === '/' ? 'index.html' : route.endsWith('/') ? route.slice(1) + 'index.html' : route.slice(1);
  return join(site, path);
}

function makeRoutes(site, sourceSha, origin) {
  const audit = JSON.parse(readFileSync(join(site, 'manifest.json'), 'utf8'));
  const routes = [
    { route:'/', label:'Development Portal', description:'Site map for Codexia design, code structure, CI observation and source audit.', category:'Overview', sourceSha, generationStatus:'ready', coverageStatus:'site-routes', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main/docs', internalLinks:['architecture/','graph/','ci/','audit/'] },
    { route:'/architecture/', label:'Architecture Atlas', description:'Rendered views of canonical Mermaid design documents.', category:'Architecture', sourceSha, generationStatus: existsSync(page(site,'/architecture/')) ? 'ready':'unavailable', coverageStatus:'see-manifest', dataKind:'build-snapshot', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/tree/main/docs', internalLinks:['./'] },
    { route:'/graph/', label:'Code Map', description:'Static code relationships extracted by Graphify.', category:'Code', sourceSha, generationStatus: existsSync(page(site,'/graph/')) ? 'ready':'unavailable', coverageStatus:'see-graph-data', dataKind:'build-snapshot', internalLinks:['../','communities.html'] },
    { route:'/ci/', label:'CI Observatory', description:'Public GitHub Actions run and job observations, fetched by the browser.', category:'Verification', sourceSha, generationStatus: existsSync(page(site,'/ci/')) ? 'ready':'unavailable', coverageStatus:'live-public-actions-api', dataKind:'browser-live', externalDocumentationUrl:'https://github.com/yohn-jp/codexia/actions', internalLinks:['../'] },
    { route:'/audit/', label:'Source Audit', description:'Repomix branch snapshots and OCR-selected review input materials. Review input is not an AI review result.', category:'Audit', sourceSha, generationStatus: existsSync(page(site,'/audit/')) ? 'ready':'unavailable', coverageStatus: audit.branches?.length ? 'branch-head-snapshots':'empty', dataKind:'branch-head-snapshot', observedAt:audit.observedAt, internalLinks:['../','../manifest.json'] },
    { route:'/graph/communities.html', label:'Community Overview', description:'Graphify community view.', category:'Code', sourceSha, generationStatus: existsSync(page(site,'/graph/communities.html')) ? 'ready':'unavailable', coverageStatus:'see-graph-data', dataKind:'build-snapshot', internalLinks:['./','../'] },
  ];
  return { schemaVersion:1, siteOrigin:origin, sourceSha, generatedAt:new Date().toISOString(), routes };
}

function renderPortal(manifest) {
  const cards = manifest.routes.filter(x => x.route !== '/').map(item => {
    const available = item.generationStatus === 'ready';
    const target = item.route === '/' ? './' : item.route.slice(1);
    return `<article><h2>${esc(item.label)}</h2><p>${esc(item.description)}</p><p><strong>${available?'Available':'Unavailable'}</strong> · ${esc(item.dataKind)} · ${esc(item.coverageStatus)}${item.observedAt?' · Observed '+esc(item.observedAt):''}</p><a href="${esc(target)}">Open ${esc(item.label)}</a>${item.externalDocumentationUrl?` · <a href="${esc(item.externalDocumentationUrl)}">GitHub source</a>`:''}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codexia Development Portal</title><style>body{font:16px system-ui,sans-serif;max-width:1100px;margin:2rem auto;padding:0 1rem;color:#24292f;line-height:1.55}header{border-bottom:1px solid #d0d7de;padding-bottom:1rem}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,19rem),1fr));gap:1rem;margin:1.5rem 0}article{border:1px solid #d0d7de;border-radius:10px;padding:1rem}h1,h2{line-height:1.2}code{overflow-wrap:anywhere}a{color:#0969da}footer{border-top:1px solid #d0d7de;padding-top:1rem}small{color:#57606a}</style></head><body><header><h1>Codexia Development Portal</h1><p>Explore canonical design documents, static code structure, public CI observations, and branch source snapshots.</p><p>Published Pages source SHA: <code>${manifest.sourceSha}</code></p></header><main>${cards}</main><footer><h2>Project links</h2><p><a href="https://github.com/yohn-jp/codexia/tree/main/docs">GitHub Docs</a> · <a href="https://github.com/yohn-jp/codexia">Repository</a> · <a href="https://github.com/yohn-jp/codexia/actions">Actions</a></p><small>Architecture and code maps are build snapshots; CI reads public Actions data in the browser; Audit lists observed branch HEAD snapshots. Status describes generated inputs, not release certification.</small></footer></body></html>\n`;
}

function inventory(site) {
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir,name), stat = lstatSync(absolute), rel = relative(site,absolute).split(sep).join('/');
      assert.ok(!stat.isSymbolicLink(), `Symlink in Pages artifact: ${rel}`);
      if (stat.isDirectory()) walk(absolute);
      else {
        assert.ok(stat.isFile(), `Non-regular Pages artifact: ${rel}`);
        assert.ok(!/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519))(?:$|\/)/iu.test(rel), `Sensitive filename in Pages artifact: ${rel}`);
        assert.ok(!/\.(?:pem|key|p12|pfx|sqlite(?:-wal|-shm)?|db)$/iu.test(rel), `Private or database artifact: ${rel}`);
        files.push({ absolute, rel, bytes:stat.size });
      }
    }
  }
  walk(site);
  const totalBytes=files.reduce((sum,file)=>sum+file.bytes,0);
  assert.ok(totalBytes<=MAX_SITE_BYTES,`Pages artifact exceeds the 900 MiB publication budget (${totalBytes} bytes)`);
  return files;
}

const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{32,}/iu,
];
function inspectSecrets(files) {
  for (const file of files) {
    const bytes = readFileSync(file.absolute);
    if (bytes.includes(0)) continue;
    const content = bytes.toString('utf8');
    for (const pattern of secretPatterns) assert.ok(!pattern.test(content), `Credential-like value in public artifact: ${file.rel}`);
  }
}

function localTarget(site, htmlPath, href, origin) {
  if (!href || /^(?:#|mailto:|tel:|data:|javascript:)/iu.test(href)) return null;
  const pageRel = relative(site, htmlPath).split(sep).join('/');
  const pageDir = pageRel.includes('/') ? pageRel.slice(0,pageRel.lastIndexOf('/')+1) : '';
  const targetUrl = new URL(href, origin + '/' + pageDir);
  if (targetUrl.origin !== new URL(origin).origin) return null;
  const prefix = new URL(origin + '/').pathname;
  assert.ok(targetUrl.pathname.startsWith(prefix), `Same-origin link escapes project base path: ${href}`);
  let relPath = decodeURIComponent(targetUrl.pathname.slice(prefix.length));
  if (!relPath || targetUrl.pathname.endsWith('/')) relPath += 'index.html';
  const normalized = resolve(site, relPath);
  assert.ok(normalized === site || normalized.startsWith(site + sep), `Link escapes Pages artifact: ${href}`);
  return normalized;
}

export function generate(siteDir, sourceSha, originValue) {
  const site = resolve(siteDir), origin = canonicalOrigin(originValue);
  assert.match(sourceSha, SHA, 'Expected exact 40-character source SHA');
  assert.equal((awaitGitHead()), sourceSha, 'Source SHA does not match the exact checked-out commit');
  assert.ok(existsSync(join(site,'manifest.json')), 'Audit branch manifest is required');
  const auditIndex = join(site,'audit','index.html');
  assert.ok(existsSync(auditIndex), 'Audit exporter must write /audit/index.html before portal generation');
  const manifest = makeRoutes(site,sourceSha,origin);
  assert.equal(manifest.routes.find(x=>x.route==='/audit/').generationStatus,'ready');
  for (const item of manifest.routes) {
    if (item.generationStatus==='ready') continue;
    const output=page(site,item.route);
    mkdirSync(resolve(output,'..'),{recursive:true});
    writeFileSync(output,`<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(item.label)} unavailable</title><h1>${esc(item.label)} unavailable</h1><p>This page was not generated for source ${sourceSha}.</p><a href="../">Portal</a></html>\n`);
  }
  writeFileSync(join(site,'index.html'),renderPortal(manifest));
  writeFileSync(join(site,'sitemap.json'),json(manifest.routes.map(({route,label,description,category})=>({route,label,description,category}))));
  writeFileSync(join(site,'site-manifest.json'),json(manifest));
  return manifest;
}

function awaitGitHead() {
  return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
}

export function verify(siteDir, originValue) {
  const site = resolve(siteDir), origin = canonicalOrigin(originValue);
  assert.ok(existsSync(site) && lstatSync(site).isDirectory(), 'Pages artifact directory required');
  const files = inventory(site);
  inspectSecrets(files);
  const manifestPath = join(site,'site-manifest.json');
  assert.ok(existsSync(manifestPath), 'Site manifest missing');
  const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
  assert.equal(manifest.siteOrigin,origin);
  assert.match(manifest.sourceSha,SHA);
  assert.deepEqual(manifest.routes.map(x=>x.route),['/','/architecture/','/graph/','/ci/','/audit/','/graph/communities.html']);
  for (const item of manifest.routes) {
    assert.ok(existsSync(page(site,item.route)), `Registered route missing: ${item.route}`);
    assert.ok(['ready','unavailable'].includes(item.generationStatus));
    for (const link of item.internalLinks) assert.ok(existsSync(localTarget(site,page(site,item.route),link,origin)), `Registered internal link missing from ${item.route}: ${link}`);
  }
  if (manifest.routes.find(x=>x.route==='/architecture/').generationStatus==='ready') {
    const atlas=JSON.parse(readFileSync(join(site,'architecture','manifest.json'),'utf8'));
    assert.equal(atlas.sourceSha,manifest.sourceSha,'Architecture source SHA differs from the published source');
  }
  if (manifest.routes.find(x=>x.route==='/graph/').generationStatus==='ready') {
    const graph=JSON.parse(readFileSync(join(site,'graph','source.json'),'utf8'));
    assert.equal(graph.sourceSha,manifest.sourceSha,'Graph source SHA differs from the published source');
  }
  assert.ok(existsSync(join(site,'manifest.json')), 'Audit manifest was replaced or omitted');
  const audit = JSON.parse(readFileSync(join(site,'manifest.json'),'utf8'));
  for (const [sha,snapshot] of Object.entries(audit.snapshots ?? {})) {
    assert.match(sha,SHA);
    if (snapshot.status==='blocked') continue;
    const folder=join(site,'snapshots',sha), meta=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));
    assert.equal(meta.sourceSha,sha);
    for (const out of meta.outputs) {
      const bytes=readFileSync(join(folder,out.name));
      assert.equal(bytes.length,out.bytes,`Snapshot size mismatch: ${sha}/${out.name}`);
      assert.equal(sha256(bytes),out.sha256,`Snapshot digest mismatch: ${sha}/${out.name}`);
    }
  }
  for (const {absolute,rel} of files) {
    if (!/\.html?$/iu.test(rel)) continue;
    const html=readFileSync(absolute,'utf8');
    for (const match of html.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/giu)) {
      const target=localTarget(site,absolute,match[2],origin);
      if (target) assert.ok(existsSync(target),`Broken internal link in ${rel}: ${match[2]}`);
    }
  }
  return { files:files.length,routes:manifest.routes.length,sourceSha:manifest.sourceSha };
}

if (process.argv[1] && resolve(process.argv[1])===self) {
  try {
    const [command,...args]=process.argv.slice(2);
    if (command==='generate' && args.length===3) console.log(JSON.stringify(generate(args[0],args[1],args[2])));
    else if (command==='verify' && args.length===2) console.log(JSON.stringify(verify(args[0],args[1])));
    else throw new Error('Usage: node scripts/audit/portal.mjs generate SITE SOURCE_SHA https://yohn-jp.github.io/codexia | verify SITE https://yohn-jp.github.io/codexia');
  } catch (error) { console.error(error.message); process.exitCode=1; }
}
