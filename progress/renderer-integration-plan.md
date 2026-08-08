# WebGPUレンダラーの本体統合計画

## Decision

プロトタイプ(層A・層B全合格、progress/quarterview-renderer-spec.md)を本体へ段階統合する。
方針は**ハイブリッド合成から始める漸進置換**: 一括置換はリスクが大きすぎるため、
「wgpu が地形(最重量部)を描き、three.js が透過キャンバスで上に動的物を描く」二層構成で
まず価値(全図ズームアウト)を出し、その後 three.js 側の担当物を段階的に wgpu へ移す。

1. **昇格**: renderer/ の crate 群を `renderer/`(リポジトリ直下、Cargoワークスペース)へ
   移動・整理する(research からの昇格。ベンチ(layer_a/layer_b ハーネス)も一緒に移し、
   回帰ゲートとして維持)。wasm-pack ビルドを npm scripts に統合(`npm run build:renderer`)
2. **二層合成**: ゲーム画面は「下層 = wgpu キャンバス(地形・水面)/上層 = three.js キャンバス
   (透過背景、レール・列車・駅・町・木・プレビュー等の既存描画)」。カメラは既存
   OrbitControls が真実源で、毎フレーム wgpu 側へ (target, zoom) を送る(wasm に
   set_camera API を追加)。座標系・投影の一致はピクセル単位で検証する(同一セルの
   地形角とレール位置のスクリーンショット比較)
3. **切替**: 設定パネルに「レンダラー: WebGPU / 従来」トグル。WebGPU 非対応環境は自動で
   従来へフォールバック(navigator.gpu 検出)。両立期間中、既存 TerrainBlocks は
   WebGPU モード時のみアンマウント
4. **編集差分**: cornerDiffs の変更を wasm へ疎転送(チャンク単位)し、該当タイルを再生成。
   terraform の反映 ≤1フレーム(T8 相当をここで初めて実測)
5. **ズームアウト解禁**: WebGPU モード時のみ minZoom を全図まで開放。遠ズームでは
   three.js 上層を段階フェードアウト(まず全消し。町ドット等の遠景表現は次フェーズ)
6. **地下・高架ビュー**: 当面 three.js 上層の担当のまま(wgpu は地表のみ)。地下ビュー時の
   地表減光は wgpu 側に dim uniform を追加して同調させる

## フェーズ

- R1: 昇格+ビルド統合+二層合成+カメラ同期+設定トグル(地形が wgpu で出る、見た目一致検証)
- R2: cornerDiffs 転送と地形編集の同期(T8実測)、地下ビュー減光の同調
- R3: ズームアウト解禁+遠景仕上げ(上層フェード、town ドット表現は wgpu 側に実装)
- R4以降: 木・町タイルのインスタンシング移管 → レール/列車 → three.js 退役判断

## Alternatives considered

- **一括置換(three.js 全退役してから統合)**: 棄却。レール・列車・UI装飾まで wgpu に
  揃うまで数週間ユーザー価値が出ず、差分も巨大化する
- **wgpu を three.js の外部テクスチャとして合成**: 棄却。キャンバス重ね合わせの方が単純で、
  ブラウザのコンポジタが十分速い

## Constraints / Gotchas

- 2キャンバスのDPR・リサイズ同期を最初に固めること(ズレの温床)
- three.js 側の地面プレーン(picking)は WebGPU モードでも維持(colorWrite:false の既存機構を流用)
- Electron での WebGPU 動作確認は R1 の完了条件に含める
- 影: wgpu 地形には three.js の影が落ちない。両立期間中は割り切る(記録済みの既知差異とする)

## R1実装メモ (0.4.0-Alpha-1a)

### 昇格した構成

- `renderer_research/proto/` → `renderer/`(git mvで履歴保持)。`terrain_core` / `renderer_wgpu`
  (shaders込み) / `web`(単独開発ページ+Playwrightハーネス) / `bench`(層Aハーネス)を
  そのまま移し、参照パスだけ新しい深さへ直した(`bench/run-layer-a.mjs`のrepoRoot、
  `vitest.direct.config.ts`のinclude、直結テストの`../../src/sim/terrainField`)。
  ベンチは `renderer/bench` に残す(恒久的な回帰ゲート)。`renderer_research/` は notes/ のみ。
- ビルド統合: `npm run build:renderer` = `wasm-pack build renderer/renderer_wgpu --release
  --target web --out-dir ../../public/renderer`。`public/` に出すことで dev では Vite が
  そのまま配信し、`vite build` は dist へコピーする。**成果物はコミットしない**
  (.gitignore に `renderer/target/` と `public/renderer/`)。本体は実行時に
  `import(new URL('renderer/…js', document.baseURI))` で遅延ロードするだけなので、
  `npm run build` に Rust は要らない(未ビルドなら従来へフォールバック)。

### カメラ同期の式(投影一致)

three.js 側は `OrthographicCamera(position=target+(20,20,20), up=+Y, enableRotate=false)`。
視線基底は `X_cam=(1,0,-1)/√2`、`Y_cam=(-1,2,-1)/√6` なので、画面中心からのピクセル変位は

```
sx        = (x - z)      / √2 * ppc
sy(下向き) = (x + z - 2y) / √6 * ppc      ppc = zoom × DPR (物理px/ワールド単位)
```

- 画面中心に来る地表点は OrbitControls の target から `(tx - ty, tz - ty)`
  (スクリーン空間パンで target.y が動くため、x/z をそのまま使うとズレる)。
- wgpu 側は `shaders/terrain_draw.wgsl` の `project()` をこの式へ置換(ISO_X=1/√2,
  ISO_Y=1/√6)。段数→ワールド高さの換算は `set_camera(cx, cz, ppc, height_per_level)` の
  第4引数(本体の OVERPASS_HEIGHT=0.8)から `height_scale = ppc × 2/√6 × height_per_level`
  として渡す。奥行きは視線方向 (1,1,1)/√3 の単調関数 `0.5-(x+z+y)/(4*half+64)` に変更。
- JS 側の同じ式は `src/render/webgpuCamera.ts`。**実際の THREE.OrthographicCamera で
  投影した結果と一致すること**を `webgpuCamera.test.ts` で固定した(target.y≠0、DPR、
  任意点)。これが投影一致の一次ゲート。
- 描画は r3f の `useFrame` から下層を叩く(`WebGpuCameraSync`)。rAF を2本に分けると
  パン中に層がずれるため、1フレーム1カメラで両層を描く。

### 実機検証(Chrome / port 5175, dpr=2)

- 全図(zoom=10, ppc=20)で wgpu の地図ダイヤモンド幅 ≈ 2496 物理px、理論値
  `4×45×(1/√2)×20 = 2545 px` と1%以内で一致。three.js が描く樹木の分布範囲が
  そのダイヤモンドの内側にぴたりと収まる。
- 同一シード・同一カメラ(zoom=25)で 従来 / WebGPU を比較 → 台地の輪郭・切れ込みが
  同じ画面位置。zoom=70 でレールを敷くと、レールの段差位置が両モードで同一。
- WebGPUモードのまま駅×2・車庫・列車を設置(ピッキングは地面プレーンのまま有効)。
  クリック座標は上記の式から逆算した位置を使い、狙ったセルにそのまま置けた。
  列車は wgpu 地形の上を走行(renderPos.y = 標高×0.8 + 0.5)。
- Electron 43(Chrome 150): `data:` URL では `navigator.gpu` が無い(セキュアコンテキスト
  でないため)。`http://localhost` と**本番の `file://dist/index.html` の両方で
  `navigator.gpu` が有効**、アダプタは apple / metal-3、`dist/renderer/` の wasm も
  読み込めることを確認済み。

### 既知の差異・R1での割り切り

- 見た目: wgpu 地形は標高クラスごとの単色(草地/山/雪)で、ライティングと影が無い。
  従来の斜面シェーディング・樹木の落ち影は上層に残るが、地形自体には落ちない。
- 地形編集(cornerDiffs)は wgpu に未転送(R2)。設定パネルの説明文にも明記。
- デバッグシナリオは field を上書きする(`fieldFromMaps`)ため、seed から地形を作る
  wgpu 側とは一致しない。シナリオ検証は従来レンダラーで行うこと。
- 地形編集モードのピッキングは、WebGPUモードでは TerrainBlocks が無いぶん地面プレーン
  (y=0)頼りになり、丘の上での精度が落ちる。
- レンダラー選択は localStorage(`cubictransim.rendererMode`)。セーブデータには入れない。
