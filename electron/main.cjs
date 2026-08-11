// Electron のメインプロセス。
// 開発時は Vite の dev サーバ(VITE_DEV_SERVER_URL)を、
// 本番は vite build の成果物(dist/index.html)を読み込む。
//
// package.json の "type": "module" 配下なので拡張子は .cjs にしている
// (Electron のエントリは CommonJS で読ませるのがいちばん素直)。
const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const devServerUrl = process.env.VITE_DEV_SERVER_URL;

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#101418',
    title: 'CubicTransim',
    show: false,
    webPreferences: {
      // レンダラはゲーム本体(信頼できる自前のコード)だけを動かす。
      // それでも Node の API は渡さない: 将来 WebGL 以外の外部資源を
      // 読み込んだときに攻撃面を広げないため。
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 白い画面のちらつきを避けるため、描画準備ができてから見せる。
  win.once('ready-to-show', () => win.show());

  // 外部リンクは OS のブラウザへ逃がす(ゲームウィンドウを乗っ取らせない)。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (devServerUrl) {
    win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  // macOS: Dock アイコンから復帰したときにウィンドウを作り直す。
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
