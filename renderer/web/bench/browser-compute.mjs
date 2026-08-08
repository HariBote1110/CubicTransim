import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../dist');
const requestedCases = Number(process.argv[2] ?? 152);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.wasm':'application/wasm' };
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
    const target = path.resolve(root, `.${rel}`);
    if (!target.startsWith(root + path.sep)) return res.writeHead(403).end('forbidden');
    const data = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (error) { res.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(String(error)); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port;

let browser;
try {
  browser = await chromium.launch({ headless:true, args:['--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-angle=vulkan','--disable-gpu-sandbox'] });
  const page = await browser.newPage({ viewport:{width:1200,height:800} });
  const consoleLines=[];
  page.on('console', msg=>consoleLines.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err=>consoleLines.push(`pageerror: ${err.message}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil:'networkidle' });
  await page.waitForFunction(()=>!!globalThis.__quarterviewTest, { timeout:15000 });

  const result = await page.evaluate(async (CASES) => {
    const GRID=257, POINTS=GRID*GRID, TILE_BYTES=POINTS*4;
    const seed=0x12345678>>>0, halfExtent=8192;
    const {cpuTilePacked,tileGenerateWgsl,profileThresholdWords}=globalThis.__quarterviewTest;
    // 地形プロファイルを巡回させ、全プロファイルのしきい値でGPU/CPUを突き合わせる。
    const PROFILES=['flat','normal','mountain'];
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
    if(!adapter) throw new Error('No Browser WebGPU adapter');
    const device=await adapter.requestDevice();
    const uncaptured=[];
    let deviceLost=null;
    device.addEventListener('uncapturederror',e=>uncaptured.push(String(e.error?.message??e.error)));
    device.lost.then(info=>{ deviceLost=`${info.reason}: ${info.message}`; });

    const module=device.createShaderModule({code:tileGenerateWgsl(),label:'terrain-tile-browser-check'});
    const pipeline=device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}});
    const storageAlignment=Math.max(4,Number(device.limits.minStorageBufferOffsetAlignment||256));
    const segmentBytes=Math.ceil(TILE_BYTES/storageAlignment)*storageAlignment;
    const totalBytes=segmentBytes*CASES;
    const output=device.createBuffer({size:totalBytes,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const readback=device.createBuffer({size:totalBytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});

    const strides=[1,2,4,8,16,32,64];
    let state=0x6d2b79f5>>>0;
    const cases=[];
    for(let caseIndex=0;caseIndex<CASES;caseIndex++){
      const stride=strides[caseIndex%strides.length];
      const tileSpan=256*stride;
      const min=-halfExtent, maxOrigin=halfExtent-tileSpan;
      const originSpan=Math.max(1,maxOrigin-min+1);
      state=(Math.imul(state,1664525)+1013904223)>>>0; const originX=min+(state%originSpan);
      state=(Math.imul(state,1664525)+1013904223)>>>0; const originZ=min+(state%originSpan);
      cases.push({caseIndex,stride,originX,originZ,profile:PROFILES[caseIndex%PROFILES.length]});
    }

    // No corner overrides in this proto check (override_count stays 0 in every params
    // buffer below), but tile_generate.wgsl@binding(2) still requires a bound storage
    // buffer to pass validation — an empty one is enough. See native edit_check.rs /
    // tile_check.rs, which bind an equivalent zero-length placeholder.
    const overridesBuffer=device.createBuffer({size:8,usage:GPUBufferUsage.STORAGE});

    const bindGroups=[];
    const paramBuffers=[];
    for(const c of cases){
      // TileParams = 8語(32byte) + しきい値20語(80byte) = 112byte。
      const bytes=new ArrayBuffer(112),dv=new DataView(bytes);
      dv.setUint32(0,seed,true); dv.setInt32(4,halfExtent,true); dv.setInt32(8,c.originX,true); dv.setInt32(12,c.originZ,true);
      dv.setInt32(16,c.stride,true); dv.setUint32(20,GRID,true);
      const thresholdWords=profileThresholdWords(c.profile);
      for(let w=0;w<20;w++) dv.setUint32(32+w*4,thresholdWords[w],true);
      const params=device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      device.queue.writeBuffer(params,0,bytes);
      paramBuffers.push(params);
      bindGroups.push(device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:params}},
        {binding:1,resource:{buffer:output,offset:c.caseIndex*segmentBytes,size:TILE_BYTES}},
        {binding:2,resource:{buffer:overridesBuffer}},
      ]}));
    }

    const started=performance.now();
    const encoder=device.createCommandEncoder();
    const pass=encoder.beginComputePass();
    pass.setPipeline(pipeline);
    for(const c of cases){
      pass.setBindGroup(0,bindGroups[c.caseIndex]);
      pass.dispatchWorkgroups(Math.ceil(POINTS/256));
    }
    pass.end();
    for(const c of cases) encoder.copyBufferToBuffer(output,c.caseIndex*segmentBytes,readback,c.caseIndex*segmentBytes,TILE_BYTES);
    device.queue.submit([encoder.finish()]);
    const mapPromise=readback.mapAsync(GPUMapMode.READ);

    // Generate the f64 Rust/WASM reference while the WebGPU queue is busy.
    const expected=[];
    for(const c of cases) expected.push(cpuTilePacked(seed,halfExtent,c.originX,c.originZ,c.stride,c.profile));
    await mapPromise;
    const words=new Uint32Array(readback.getMappedRange());
    const segmentWords=segmentBytes/4;
    let mismatches=0;
    const first=[];
    for(const c of cases){
      const exp=expected[c.caseIndex];
      const base=c.caseIndex*segmentWords;
      for(let i=0;i<POINTS;i++){
        const actual=words[base+i];
        if(actual!==exp[i]){
          mismatches++;
          if(first.length<12) first.push({...c,i,expected:exp[i],actual});
        }
      }
    }
    readback.unmap();
    await device.queue.onSubmittedWorkDone();
    return {
      kind:'browser-webgpu-noise-check',backend:'BrowserWebGpu',cases:CASES,points:CASES*POINTS,profiles:PROFILES,mismatches,first,
      elapsedMs:performance.now()-started,uncaptured,deviceLost,adapterInfo:adapter.info??{},
      storageAlignment,segmentBytes,totalBufferMiB:totalBytes/1048576,
    };
  }, requestedCases);

  console.log(JSON.stringify({...result,consoleLines}));
  if(result.mismatches!==0||result.uncaptured.length!==0||result.deviceLost) process.exitCode=1;
} finally {
  if(browser) await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
