import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';

const workspaceRoot=fileURLToPath(new URL('../../../',import.meta.url));
const fixturePort=18766;
const fixtureOrigin=`http://127.0.0.1:${fixturePort}`;
const clientId='codexia-static-smoke-public-client';
const audience=`${fixtureOrigin}/api`;
const issuer=`${fixtureOrigin}/api/auth`;
const settings={
  VITE_CODEXIA_OAUTH_ISSUER:issuer,
  VITE_CODEXIA_OAUTH_CLIENT_ID:clientId,
  VITE_CODEXIA_API_AUDIENCE:audience,
  VITE_CODEXIA_OAUTH_DESKTOP_REDIRECT_URI:`${fixtureOrigin}/desktop`,
  VITE_CODEXIA_OAUTH_MOBILE_REDIRECT_URI:`${fixtureOrigin}/mobile`,
  VITE_CODEXIA_OAUTH_SCOPES:'openid codexia:api',
};
const metadata={
  issuer,
  authorization_endpoint:`${issuer}/oauth2/authorize`,
  token_endpoint:`${issuer}/oauth2/token`,
  response_types_supported:['code'],
  grant_types_supported:['authorization_code'],
  token_endpoint_auth_methods_supported:['none'],
  code_challenge_methods_supported:['S256'],
  authorization_response_iss_parameter_supported:true,
  scopes_supported:['openid','codexia:api'],
};

const scratch=await mkdtemp(join(tmpdir(),'codexia-oauth-static-smoke-'));
let server;
let browser;
try {
  const fixtureDist=join(scratch,'dist');
  const build=spawnSync('pnpm',['--filter','@codexia/app','run','build'],{
    cwd:workspaceRoot,
    env:{...process.env,CODEXIA_PROFILE:'full',CODEXIA_VITE_BUILD_OUTPUT_ROOT:fixtureDist,...settings},
    stdio:'inherit',
  });
  if(build.error)throw build.error;
  if(build.status!==0)throw new Error(`OAuth static fixture build exited with status ${String(build.status)}`);
  for(const name of ['_headers','_redirects'])await copyFile(join(workspaceRoot,'edge/frontend/static',name),join(fixtureDist,name));
  await mkdir(join(fixtureDist,'desktop'),{recursive:true});
  await copyFile(join(workspaceRoot,'app/dist/desktop/update-identity.json'),join(fixtureDist,'desktop/update-identity.json'));

  const configPath=join(scratch,'wrangler.jsonc');
  await writeFile(configPath,JSON.stringify({
    name:'codexia-oauth-static-smoke',
    compatibility_date:'2026-11-08',
    workers_dev:false,
    preview_urls:false,
    assets:{directory:fixtureDist,html_handling:'none',not_found_handling:'none'},
  })+'\n');
  server=spawn('edge/frontend/node_modules/.bin/wrangler',[
    'dev','--config',configPath,'--local','--ip','127.0.0.1','--port',String(fixturePort),
  ],{cwd:workspaceRoot,stdio:'inherit'});
  let ready=false;
  for(let attempt=0;attempt<60;attempt+=1){
    try{const response=await fetch(`${fixtureOrigin}/`);if(response.ok){ready=true;break;}}catch{}
    if(server.exitCode!==null)throw new Error(`OAuth static server exited with status ${String(server.exitCode)}`);
    await delay(500);
  }
  assert.ok(ready,'OAuth static Worker did not become ready');

  const systemChromium=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser=await chromium.launch({headless:true,...(systemChromium?{executablePath:systemChromium,args:['--no-sandbox']}: {})});
  for(const shell of ['desktop','mobile']){
    const expectedRedirect=`${fixtureOrigin}/${shell}`;
    const page=await browser.newPage();
    const errors=[];
    const authorizationRequests=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/version',route=>route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify({name:'codexia',version:'0.1.0',profile:'full',hosted:false}),
    }));
    await page.route('**/api/session',route=>route.fulfill({
      status:401,
      contentType:'application/json',
      body:JSON.stringify({error:'Sign in required',code:'UNAUTHORIZED'}),
    }));
    await page.route('**/.well-known/oauth-authorization-server/api/auth',route=>route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify(metadata),
    }));
    await page.route('**/api/auth/oauth2/authorize**',async route=>{
      authorizationRequests.push(new URL(route.request().url()));
      await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Fake IdP accepted request</title>'});
    });
    try{
      await page.goto(`${fixtureOrigin}/${shell}`,{waitUntil:'domcontentloaded'});
      await page.getByRole('heading',{name:'作品を開く',exact:true}).waitFor({timeout:20000});
      await page.getByRole('button',{name:'OAuthでサインイン',exact:true}).click();
      await page.waitForURL(url=>url.pathname==='/api/auth/oauth2/authorize',{timeout:10000});
      assert.equal(authorizationRequests.length,1,`${shell} must send one authorization request to the fake IdP`);
      const authorization=authorizationRequests[0];
      assert.equal(authorization.searchParams.get('client_id'),clientId,shell);
      assert.equal(authorization.searchParams.get('resource'),audience,shell);
      assert.equal(authorization.searchParams.get('redirect_uri'),expectedRedirect,shell);
      assert.equal(authorization.searchParams.get('response_type'),'code',shell);
      assert.equal(authorization.searchParams.get('scope'),'openid codexia:api',shell);
      assert.equal(authorization.searchParams.get('code_challenge_method'),'S256',shell);
      assert.match(authorization.searchParams.get('state')??'',/^[A-Za-z0-9_-]{43}$/u,shell);
      assert.match(authorization.searchParams.get('code_challenge')??'',/^[A-Za-z0-9_-]{43}$/u,shell);
      assert.equal(authorization.searchParams.has('client_secret'),false,shell);
      assert.deepEqual(errors,[],`${shell} browser exceptions`);
    }finally{await page.close();}
  }
  console.log('OAuth settings from distribution-shaped static assets start public-client authorization with both registered shell redirects');
}finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null)await new Promise(resolve=>{server.once('exit',resolve);server.kill('SIGTERM');});
  await rm(scratch,{recursive:true,force:true});
}
