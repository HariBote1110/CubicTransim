// 開発時の Electron 起動スクリプト。
//
// Vite の dev サーバを programmatic API で起動してから、その URL を
// VITE_DEV_SERVER_URL に入れて Electron を子プロセスとして立ち上げる。
// concurrently / wait-on を足さずに「サーバが立ってから Electron」を保証できる。
import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5173 } });
await server.listen();

const url = server.resolvedUrls?.local?.[0];
if (!url) {
  await server.close();
  throw new Error('Vite dev サーバの URL を取得できませんでした');
}
server.printUrls();

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

// Electron を閉じたら Vite も落とす(dev サーバの取り残しを防ぐ)。
child.on('close', async code => {
  await server.close();
  process.exit(code ?? 0);
});
