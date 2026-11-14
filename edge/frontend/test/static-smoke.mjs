import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';
const port=18765;
const base='http://127.0.0.1:'+port;
const child=spawn('edge/frontend/node_modules/.bin/wrangler',['dev','--config','edge/frontend/wrangler.jsonc','--local','--ip','127.0.0.1','--port',String(port)],{stdio:'inherit'});
try {
  let ready=false;
  for(let i=0;i<60;i++){try{const r=await fetch(base+'/');if(r.ok){ready=true;break;}}catch{}await delay(500);}
  assert.ok(ready,'Wrangler static asset server did not become ready');
  for(const [path,prefix] of [['/?utm_source=smoke','/assets/'],['/desktop','/desktop/assets/'],['/desktop/projects/a/scenes/b?x=1','/desktop/assets/'],['/mobile/settings/','/mobile/assets/'],['/r/story/123e4567-e89b-12d3-a456-426614174000/reader','/assets/']]){
    const response=await fetch(base+path,{redirect:'manual'});assert.equal(response.status,200,path);assert.match(response.headers.get('content-type')??'',/text\/html/);assert.match(response.headers.get('content-security-policy')??'',/script-src 'self'/);const html=await response.text();const js=html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];assert.ok(js?.startsWith(prefix),path+' script path: '+js);const script=await fetch(base+js);assert.equal(script.status,200,js);assert.match(script.headers.get('content-type')??'',/javascript/);assert.ok((await script.text()).length>100);}
  for(const path of ['/assets/does-not-exist.js','/desktop/assets/missing.js','/unknown','/api/login'])assert.equal((await fetch(base+path,{redirect:'manual'})).status,404,path);
  // Exercise real browser module loading under the deployed static CSP.
  // No API proxy or credentials: the isolated static server must render
  // the explicit API-unavailable state instead of hanging at the loader.
  const browser=await chromium.launch({headless:true});
  try {
    for(const [path,heading] of [['/?utm_source=smoke','執筆画面を選ぶ'],['/desktop','PostgreSQLへ接続できません'],['/mobile/settings/','PostgreSQLへ接続できません']]){
      const page=await browser.newPage();
      const errors=[];
      page.on('pageerror',error=>errors.push(error.message));
      try {
        await page.goto(base+path,{waitUntil:'domcontentloaded'});
        await page.getByRole('heading',{name:heading,exact:true}).waitFor({timeout:20000});
        assert.deepEqual(errors,[],path+' browser exceptions');
      } finally {await page.close();}
    }
  } finally {await browser.close();}
  console.log('Static-only Wrangler serving and browser entrypoints verified');
} finally {child.kill('SIGTERM');}
