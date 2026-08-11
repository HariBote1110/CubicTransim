# Electron 起動と借入システム

## Decision

### Electron 化(v0.3.0-Alpha-3)
- `electron/main.cjs` をメインプロセスにした。`VITE_DEV_SERVER_URL` があればその URL を、
  無ければ `dist/index.html` を `loadFile` する二択だけの薄い実装。
- 開発時は `electron/dev.mjs` が Vite を programmatic API (`createServer`) で起動し、
  `resolvedUrls` を環境変数に入れて Electron を子プロセスで立ち上げる。
- `vite.config.ts` の `base` を `'./'` にした。`file://` から読むとき絶対パスだと
  assets を解決できないため。
- 配布ビルド(electron-builder)は今回のスコープ外。

### 借入(v0.3.0-Alpha-3)
- 序盤に建設しすぎると資金が尽き、列車を買えないまま詰む。これを防ぐために
  OpenTTD 型の「上限まで自由に借りられ、月末に利息だけ払う」ローンを入れた。
- 上限 ¥200,000、刻み ¥10,000、年利 5%(`src/sim/loans.ts`)。
- 返済は「手持ち」と「借入残高」の小さいほうまで。所持金がマイナスのときは返済不可。
- 利息は月末(`monthEnd` イベント)に所持金から引き、`MonthlyLedger.interest` に記録する。

## Alternatives considered
- **返済期限つきの融資・信用格付け**: 詰み回避が目的なのに判断材料が増えるだけなので却下。
- **concurrently + wait-on で dev サーバと Electron を並走**: 依存を2つ増やすうえ
  「サーバが立ってから Electron」の保証が待ち時間頼みになる。Vite の programmatic API なら
  `await server.listen()` で順序が確定するので不要と判断した。
- **package.json の `main` を .js にする**: `"type": "module"` 配下では ESM 扱いになり
  Electron のエントリとして扱いづらい。`.cjs` にした。

## Constraints / Gotchas
- **`setState` の updater 内で別の `setState` を呼ぶと StrictMode で二重に走る**。
  月次決算が `setCurrentLedger(l => { setLedgerHistory(...); ... })` になっており、
  収支履歴に同じ月が2行出ていた。updater は純粋に保ち、履歴の push は外で行うこと。
- セーブデータは v10。v9 以前は借入0・台帳の利息0で移行する。v9 以前の台帳型は
  `interest` を持たないため、`LegacyLedger`(interest 省略可)として型を分けている。
- ブラウザ検証中に何度もリロードすると WebGL コンテキストが尽きてキャンバスが
  真っ白になり、`window.__dbgStep` も生えてこない。`preview_stop` → `preview_start`
  でタブごと作り直すのが早い。
