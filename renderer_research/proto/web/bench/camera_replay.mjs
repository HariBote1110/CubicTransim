import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../dist');
const mime = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm' };
const server = http.createServer(async (req,res)=>{
  try { const u=new URL(req.url??'/','http://127.0.0.1'); let rel=decodeURIComponent(u.pathname); if(rel==='/')rel='/index.html'; const target=path.resolve(root,'.'+rel); if(!target.startsWith(root+path.sep)){res.writeHead(403).end();return;} const data=await fs.readFile(target); res.writeHead(200,{'Content-Type':mime[path.extname(target)]??'application/octet-stream','Cache-Control':'no-store','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end(data); } catch(e){res.writeHead(e?.code==='ENOENT'?404:500).end(String(e));}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const address=server.address(); const url=`http://127.0.0.1:${address.port}/`;
const percentile=(a,p)=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.ceil((s.length-1)*p))];};
const histogram=(values)=>{const edges=[0,1,2,3,4,5,6,8,10,12,16.6,33,50,Infinity];const bins=[];for(let i=0;i<edges.length-1;i++)bins.push({minMs:edges[i],maxMs:edges[i+1],count:0});for(const v of values){let i=edges.findIndex((e,j)=>j<edges.length-1&&v>=e&&v<edges[j+1]);if(i<0)i=bins.length-1;bins[i].count++;}return bins;};
const summarize=(name,history)=>{const raf=history.map(x=>x.rafMs);const cpu=history.map(x=>x.cpuMs);const hitches=cpu.filter(x=>x>16.6).length;return {name,frames:history.length,raf:{medianMs:percentile(raf,.5),p95Ms:percentile(raf,.95),p99Ms:percentile(raf,.99),maxMs:Math.max(...raf),histogram:histogram(raf)},wasmCpu:{medianMs:percentile(cpu,.5),p95Ms:percentile(cpu,.95),p99Ms:percentile(cpu,.99),maxMs:Math.max(...cpu),hitchesOver16_6ms:hitches,histogram:histogram(cpu)},last:history.at(-1)??null};};
let browser;
try {
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-angle=vulkan','--disable-gpu-sandbox','--disable-software-rasterizer=false']});
  const page=await browser.newPage({viewport:{width:1200,height:800}});
  const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(url,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>globalThis.__quarterviewControl && globalThis.__quarterviewRenderer,{timeout:15000});
  const runPhase=async(name,setup,perFrame,frames=120)=>page.evaluate(async({name,setup,perFrame,frames})=>{
    const c=globalThis.__quarterviewControl;c.clearHistory();
    if(setup)c[setup[0]](...setup.slice(1));
    for(let i=0;i<frames;i++){
      await new Promise(requestAnimationFrame);
      if(perFrame) c[perFrame[0]](...perFrame.slice(1).map(v=>typeof v==='string'&&v==='${i}'?i:v));
    }
    return {name,history:c.history()};
  },{name,setup,perFrame,frames});

  // 1. Static camera: settle at normal detailed zoom.
  const staticRun=await runPhase('static', ['setCamera',0,0,100], null, 120);
  // 2. Maximum-speed pan: large fixed screen delta every frame until clamped by map bounds.
  const panRun=await page.evaluate(async()=>{const c=globalThis.__quarterviewControl;c.setCamera(0,0,100);c.clearHistory();for(let i=0;i<120;i++){await new Promise(requestAnimationFrame);c.panPixels(180,90);}return {name:'max-speed-pan',history:c.history()};});
  // 3. Full-map view.
  const fullRun=await page.evaluate(async()=>{const c=globalThis.__quarterviewControl;c.setCamera(0,0,c.fitPpc());c.clearHistory();for(let i=0;i<120;i++)await new Promise(requestAnimationFrame);return {name:'full-map',history:c.history()};});
  // 4. Zoom round-trip: 90 frames in, 90 frames out.
  const zoomRun=await page.evaluate(async()=>{const c=globalThis.__quarterviewControl;c.setCamera(0,0,100);c.clearHistory();for(let i=0;i<90;i++){await new Promise(requestAnimationFrame);c.zoomBy(Math.exp(0.035));}for(let i=0;i<90;i++){await new Promise(requestAnimationFrame);c.zoomBy(Math.exp(-0.035));}return {name:'zoom-roundtrip',history:c.history()};});
  const phases=[staticRun,panRun,fullRun,zoomRun].map(x=>summarize(x.name,x.history));
  const all=phases.flatMap(p=>p.raf?[]:[]);
  console.log(JSON.stringify({ok:errors.length===0,hasGpu:await page.evaluate(()=>!!navigator.gpu),phases,errors}));
} finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
