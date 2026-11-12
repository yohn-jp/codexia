import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStableProxy} from '../deploy/updater/proxy.mjs';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
test('private proxy routes by durable slot, preserves request body and auth, fails closed',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'codexia-proxy-'));const route=path.join(dir,'route');
 const backend=slot=>http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('connection','close');res.setHeader('x-codexia-upstream-slot','spoofed');res.end(JSON.stringify({slot,body,authorization:req.headers.authorization,proto:req.headers['x-forwarded-proto'],url:req.url}))});
 const blue=backend('blue'),green=backend('green');const targets={blue:await listen(blue),green:await listen(green)};const p=createStableProxy({routeFile:route,targets});const url=await listen(p);
 try{assert.equal((await fetch(url)).status,503);await writeFile(route,'blue');let response=await fetch(url+'/api/test?x=1',{method:'POST',headers:{authorization:'Bearer test','x-forwarded-proto':'http'},body:'test'});assert.equal(response.headers.get('x-codexia-upstream-slot'),'blue');assert.deepEqual(await response.json(),{slot:'blue',body:'test',authorization:'Bearer test',proto:'https',url:'/api/test?x=1'});await writeFile(route,'green');response=await fetch(url);assert.equal((await response.json()).slot,'green');await writeFile(route,'blocked');assert.equal((await fetch(url)).status,503);}
 finally{await Promise.all([close(p),close(blue),close(green)]);await rm(dir,{recursive:true,force:true})}
});
