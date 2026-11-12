import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function filtered(headers){
  const excluded=new Set(hop);
  for(const token of String(headers.connection??'').split(','))excluded.add(token.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key])=>!excluded.has(key.toLowerCase())));
}
function unavailable(response){if(!response.headersSent)response.writeHead(503,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Retry-After':'2'});response.end('Codexia API temporarily unavailable\n');}

/** Private Tunnel ingress only. Never accepts a destination from client input. */
export function createStableProxy({routeFile,targets={blue:'http://codexia-slot-blue:3000',green:'http://codexia-slot-green:3000'}}){
  const server=http.createServer(async(req,res)=>{
    let route;
    try{route=(await readFile(routeFile,'utf8')).trim();}catch{return unavailable(res);}
    if(!['blue','green'].includes(route))return unavailable(res);
    // Cloudflare Access remains the external ingress. Preserve the original Host and
    // establish HTTPS for the private forwarded hop, not a client-chosen forwarding chain.
    const headers=filtered(req.headers);
    delete headers['x-forwarded-host'];delete headers['x-forwarded-port'];
    headers['x-forwarded-proto']='https';
    let upstream;
    try{upstream=http.request(targets[route],{method:req.method,path:req.url,headers},reply=>{
      const out=filtered(reply.headers);
      delete out['x-codexia-upstream-slot'];
      if(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))out['x-codexia-upstream-slot']=route;
      res.writeHead(reply.statusCode??502,out);
      res.flushHeaders();reply.pipe(res);
      reply.on('error',()=>res.destroy());
    });}catch{return unavailable(res);}
    upstream.on('error',()=>{if(res.headersSent)res.destroy();else unavailable(res);});
    req.on('aborted',()=>upstream.destroy());
    res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
    req.pipe(upstream);
  });
  server.on('upgrade',(_req,socket)=>socket.destroy());
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  createStableProxy({routeFile:'/config/state/route'}).listen(3000,'0.0.0.0');
}
