import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { finalize, generate, verify } from './portal.mjs';

const origin='https://yohn-jp.github.io/codexia';
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const digest=content=>createHash('sha256').update(content).digest('hex');
const put=(path,content)=>writeFileSync(path,content);
function records(contents) {
  return Object.entries(contents).map(([name,content])=>({name,bytes:Buffer.byteLength(content),sha256:digest(content)}));
}
function fixture() {
  const site=mkdtempSync(join(tmpdir(),'codexia-pages-portal-'));
  const snap={
    'repomix.json':JSON.stringify({audit:{sourceSha:sha,status:'ready'},files:{'src/a.ts':'export const a=1;'}}),
    'part-0001.json':'{"scope":"01-test"}\n',
  };
  const snapOutputs=records(snap);
  const snapManifest={schemaVersion:1,sourceSha:sha,status:'ready',files:[{path:'src/a.ts'}],excluded:[],outputs:snapOutputs};
  const review={
    'gemini-review.md':'Review input only.\n','gemini-diff.md':'Diff input only.\n',
    'preview.json':'{}\n','rules.json':'{}\n','index.md':'Review index\n',
    'index.html':`<!doctype html><html lang="en"><head><title>Review</title></head><body><a href="../../audit/#sha-${sha}">Return</a></body></html>\n`,
  };
  const reviewOutputs=records(review);
  mkdirSync(join(site,'audit'),{recursive:true});
  mkdirSync(join(site,'snapshots',sha),{recursive:true});
  mkdirSync(join(site,'reviews',sha),{recursive:true});
  put(join(site,'snapshots',sha,'manifest.json'),JSON.stringify(snapManifest));
  for(const [name,content] of Object.entries(snap)) put(join(site,'snapshots',sha,name),content);
  const reviewManifest={schemaVersion:1,status:'ready',sourceSha:sha,published:1,omitted:0,outputs:reviewOutputs};
  put(join(site,'reviews',sha,'manifest.json'),JSON.stringify(reviewManifest));
  for(const [name,content] of Object.entries(review)) put(join(site,'reviews',sha,name),content);
  put(join(site,'manifest.json'),JSON.stringify({
    schemaVersion:1,observedAt:'2026-11-23T00:00:00Z',
    branches:[{branch:'main',sha}],
    snapshots:{[sha]:{status:'ready',fileCount:1,excludedCount:0,outputs:snapOutputs}},
    reviews:{[sha]:{status:'ready',published:1,omitted:0}},
  }));
  put(join(site,'audit','index.html'),`<!doctype html><html><head><title>Audit</title></head><body><tr id="sha-${sha}"></tr><a href="../manifest.json">Manifest</a></body></html>`);
  for (const route of ['architecture','graph','ci']) {
    mkdirSync(join(site,route),{recursive:true});
    put(join(site,route,'index.html'),`<!doctype html><html><head><title>${route}</title></head><body><a href="../">Portal</a></body></html>`);
  }
  mkdirSync(join(site,'security'),{recursive:true});
  for (const name of ['index.html','app.mjs','api.mjs','security.css']) {
    copyFileSync(new URL('../code-scanning-pages/site/' + name,import.meta.url),join(site,'security',name));
  }
  mkdirSync(join(site,'architecture','svg'),{recursive:true});
  put(join(site,'architecture','atlas.css'),'');
  put(join(site,'architecture','atlas.js'),'');
  put(join(site,'architecture','svg','user-1.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  put(join(site,'architecture','manifest.json'),JSON.stringify({sourceSha:sha,diagrams:[{id:'user-1',image:'svg/user-1.svg'}]}));
  put(join(site,'graph','source.json'),JSON.stringify({sourceSha:sha}));
  put(join(site,'graph','analysis.mjs'),'export const analyze = true;\n');
  put(join(site,'graph','communities.html'),'<html><body><a href="./">Graph</a></body></html>');
  return site;
}
function cleanup(site) { rmSync(site,{recursive:true,force:true}); }

test('generates and verifies sitemap, SHA landing pages and review integrity after navigation finalization',()=>{
  const site=fixture();
  try {
    const auditManifest=readFileSync(join(site,'manifest.json'),'utf8');
    const registry=generate(site,sha,origin);
    assert.equal(registry.routes.length,10);
    assert.equal(registry.routes.find(route=>route.route==='/ci/').sourceSha,undefined);
    assert.equal(registry.routes.find(route=>route.route==='/audit/').sourceSha,undefined);
    assert.equal(registry.routes.find(route=>route.route==='/architecture/').sourceSha,sha);
    assert.equal(registry.routes.find(route=>route.route==='/security/').sourceSha,undefined);
    assert.ok(readFileSync(join(site,'snapshots',sha,'index.html'),'utf8').includes(sha));
    const home=readFileSync(join(site,'index.html'),'utf8');
    assert.match(home,/Pages build source SHA/u);
    assert.match(home,/Open audit branch manifest/u);
    assert.match(home,new RegExp(`snapshots/${sha}/`,'u'));
    assert.match(home,new RegExp(`href="snapshots/${sha}/repomix.json" download="codexia-${sha}-repomix.json">Download Snapshot JSON`,'u'));
    assert.match(home,new RegExp(`reviews/${sha}/index.html`,'u'));
    assert.match(readFileSync(join(site,'snapshots',sha,'index.html'),'utf8'),/download="codexia-[a-f0-9]{40}-repomix\.json"/u);
    assert.equal(readFileSync(join(site,'manifest.json'),'utf8'),auditManifest);
    assert.deepEqual(verify(site,origin).routes,10);
    put(join(site,'reviews',sha,'index.html'),readFileSync(join(site,'reviews',sha,'index.html'),'utf8')+'<nav>Shared navigation</nav>');
    assert.throws(()=>verify(site,origin),/Output (?:size|digest) mismatch/u);
    assert.deepEqual(finalize(site,origin),{finalizedReviews:1});
    assert.equal(verify(site,origin).routes,10);
  } finally { cleanup(site); }
});

test('rejects sitemap drift, invalid origins, missing internal links and hash targets',()=>{
  const site=fixture();
  try {
    generate(site,sha,origin);
    assert.throws(()=>verify(site,'https://example.invalid'),/canonical public repository site/u);
    put(join(site,'sitemap.json'),'[]');
    assert.throws(()=>verify(site,origin),/Sitemap does not match/u);
    put(join(site,'sitemap.json'),JSON.stringify(JSON.parse(readFileSync(join(site,'site-manifest.json'),'utf8')).routes.map(({route,label,description,category})=>({route,label,description,category}))));
    put(join(site,'audit','index.html'),`<a href="../manifest.json#missing-${sha}">bad fragment</a>`);
    assert.throws(()=>verify(site,origin),/fragment target is missing/u);
    put(join(site,'audit','index.html'),`<tr id="sha-${sha}"></tr>`);
    put(join(site,'index.html'),readFileSync(join(site,'index.html'),'utf8')+'<a href="missing.html">bad link</a>');
    assert.throws(()=>verify(site,origin),/Broken internal link/u);
  } finally { cleanup(site); }
});

test('rejects top-level snapshot registry mismatch and undeclared SHA files or directories',()=>{
  const site=fixture();
  try {
    generate(site,sha,origin);
    const auditPath=join(site,'manifest.json'),audit=JSON.parse(readFileSync(auditPath,'utf8'));
    audit.snapshots[sha].outputs[0].bytes+=1;
    put(auditPath,JSON.stringify(audit));
    assert.throws(()=>verify(site,origin),/Snapshot output registries disagree/u);
    audit.snapshots[sha].outputs[0].bytes-=1;
    put(auditPath,JSON.stringify(audit));
    mkdirSync(join(site,'reviews',sha,'undeclared'),{recursive:true});
    put(join(site,'reviews',sha,'undeclared','file.txt'),'unexpected');
    assert.throws(()=>verify(site,origin),/Undeclared output in SHA directory/u);
  } finally { cleanup(site); }
});

test('rejects Atlas manifest paths without matching SVG assets and phantom build files',()=>{
  const site=fixture();
  try {
    generate(site,sha,origin);
    put(join(site,'architecture','svg','staging.tmp'),'not published');
    assert.throws(()=>verify(site,origin),/Architecture SVG directory differs from manifest/u);
  } finally { cleanup(site); }
  const other=fixture();
  try {
    const atlas=JSON.parse(readFileSync(join(other,'architecture','manifest.json'),'utf8'));
    atlas.diagrams[0].id='admin-404';
    atlas.diagrams[0].image='svg/admin-404.svg';
    put(join(other,'architecture','manifest.json'),JSON.stringify(atlas));
    generate(other,sha,origin);
    assert.throws(()=>verify(other,origin),/Architecture SVG asset is missing/u);
  } finally { cleanup(other); }
});

test('rejects credential-like values and symlinked publication files',()=>{
  const site=fixture();
  try {
    generate(site,sha,origin);
    put(join(site,'ci','leak.txt'),'ghp_'+'A'.repeat(40));
    assert.throws(()=>verify(site,origin),/Credential-like value/u);
    unlinkSync(join(site,'ci','leak.txt'));
    symlinkSync(join(site,'manifest.json'),join(site,'ci','redirect.json'));
    assert.throws(()=>verify(site,origin),/Symlink in Pages artifact/u);
  } finally { cleanup(site); }
});

test('review finalization rejects symlinked files before updating integrity metadata', () => {
  const site = fixture();
  try {
    generate(site, sha, origin);
    const folder = join(site, 'reviews', sha);
    for (const [name, message] of [
      ['manifest.json', /Review manifest is not a regular file/u],
      ['index.html', /Review index is not a regular file/u],
    ]) {
      const path = join(folder, name);
      const original = join(site, name + '.original');
      renameSync(path, original);
      const bytes = readFileSync(original);
      symlinkSync(original, path);
      assert.throws(() => finalize(site, origin), message);
      assert.deepEqual(readFileSync(original), bytes);
      unlinkSync(path);
      renameSync(original, path);
    }
    assert.deepEqual(finalize(site, origin), { finalizedReviews: 1 });
    assert.equal(verify(site, origin).routes, 10);
  } finally { cleanup(site); }
});

test('records and validates LikeC4 source, lock and published SVG provenance',()=>{
  const site=fixture();
  try {
    const atlasPath=join(site,'architecture','manifest.json');
    const atlas=JSON.parse(readFileSync(atlasPath,'utf8'));
    const model=readFileSync('docs/architecture/likec4/model.likec4');
    atlas.diagrams.push({id:'system-1', image:'svg/system-1.svg', sourceModel:'docs/architecture/likec4/model.likec4', sourceModelSha256:digest(model)});
    put(atlasPath,JSON.stringify(atlas));
    put(join(site,'architecture','svg','system-1.svg'),'<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const registry=generate(site,sha,origin);
    assert.equal(registry.likec4.sourceSha,sha);
    assert.equal(registry.likec4.model.sha256,digest(model));
    assert.equal(registry.likec4.generator.version,'1.61.0');
    assert.equal(registry.likec4.generator.lockSha256,digest(readFileSync('scripts/architecture/package-lock.json')));
    verify(site,origin);
    put(join(site,'architecture','svg','system-1.svg'),'<svg>changed</svg>');
    assert.throws(()=>verify(site,origin),/LikeC4.*digest/u);
  } finally {cleanup(site);}
});
