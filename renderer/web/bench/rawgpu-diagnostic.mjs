import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../dist');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.wasm':'application/wasm','.css':'text/css' };
const server=http.createServer(async(req,res)=>{try{let u=new URL(req.url??'/','http://x');let rel=u.pathname==='/'?'/index.html':u.pathname;let f=path.resolve(root,`.${rel}`);let d=await fs.readFile(f);res.writeHead(200,{'Content-Type':mime[path.extname(f)]??'application/octet-stream','Cache-Control':'no-store'});res.end(d)}catch(e){res.writeHead(404).end(String(e))}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
let browser;
try {
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-angle=vulkan','--disable-gpu-sandbox']});
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  const logs=[]; page.on('console',m=>logs.push(`${m.type()}: ${m.text()}`)); page.on('pageerror',e=>logs.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'networkidle'});
  await page.waitForTimeout(1000);
  const raw=await page.evaluate(async()=>{
    const adapter=await navigator.gpu.requestAdapter();
    const device=await adapter.requestDevice();
    const c=document.createElement('canvas'); c.id='raw-gpu-test'; c.width=320; c.height=180;
    Object.assign(c.style,{position:'fixed',left:'440px',top:'300px',width:'320px',height:'180px',zIndex:'9999',border:'4px solid white'});
    document.body.appendChild(c);
    const ctx=c.getContext('webgpu');
    const format=navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({device,format,alphaMode:'opaque'});
    const tex=ctx.getCurrentTexture();
    const enc=device.createCommandEncoder();
    const pass=enc.beginRenderPass({colorAttachments:[{view:tex.createView(),clearValue:{r:1,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
    pass.end(); device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    await new Promise(requestAnimationFrame);
    return {format, adapterInfo: adapter.info ?? null};
  });
  await page.screenshot({path:'../bench/browser-rawgpu.png'});
  console.log(JSON.stringify({raw,logs}));
} finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)); }
