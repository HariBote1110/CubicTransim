import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const target = path.resolve(root, `.${rel}`);
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(error?.code === 'ENOENT' ? 404 : 500).end(String(error));
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const url = `http://127.0.0.1:${address.port}/`;

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
      '--use-angle=vulkan',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer=false',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const consoleLines = [];
  page.on('console', msg => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  page.on('pageerror', err => consoleLines.push(`pageerror: ${err.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  const hasGpu = await page.evaluate(() => !!navigator.gpu);
  let hud = '';
  let ok = false;
  try {
    await page.waitForFunction(() => {
      const text = document.querySelector('#hud')?.textContent || '';
      return text.includes('Quarter-view') && !text.includes('booting');
    }, { timeout: 15000 });
    hud = await page.locator('#hud').textContent();
    ok = true;
  } catch {
    hud = await page.locator('#hud').textContent().catch(() => '');
  }
  const diagnostics = await page.evaluate(() => ({
    firstFrameMs: globalThis.__quarterviewFirstFrameAt ?? null,
    firstStats: globalThis.__quarterviewFirstStats ?? null,
    lastStats: globalThis.__quarterviewLastStats ?? null,
    wasmHeapBytes: globalThis.__quarterviewTest?.wasmMemory?.buffer?.byteLength ?? null,
  }));
  await page.screenshot({ path: '../bench/browser-initial.png' });

  if (ok) {
    await page.keyboard.press('0');
    await page.waitForTimeout(700);
    const fullMapHud = await page.locator('#hud').textContent();
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(700, 460, { steps: 5 });
    await page.mouse.up();
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(700);
    const movedHud = await page.locator('#hud').textContent();
    await page.screenshot({ path: '../bench/browser-moved.png' });
    console.log(JSON.stringify({ ok, hasGpu, hud, fullMapHud, movedHud, diagnostics, consoleLines }));
  } else {
    const errorText = await page.locator('#error').textContent().catch(() => '');
    console.log(JSON.stringify({ ok, hasGpu, hud, errorText, diagnostics, consoleLines }));
    process.exitCode = 1;
  }
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
