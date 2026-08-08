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

## R2実装メモ (0.4.0-Alpha-2a)

### GPU側オーバーライド構造

`renderer/renderer_wgpu/src/lib.rs` に target非依存の `edits` モジュールを追加した(wasm・
ネイティブ検証バイナリの両方から使う)。

- `OverrideChunks = HashMap<(i32,i32), HashMap<u32,u8>>`。terrainOverlay.ts の
  `CornerDiffs`(`Map<string, Map<number,number>>`)と同じ2段構成をそのままミラーする
  (chunkKey=(cx,cz)、localIndex=`lx*OVERLAY_CHUNK_SIZE+lz`)。JS→wasm 転送は
  `setCornerOverrideChunk(chunkX, chunkZ, entries: Uint32Array)` の1本のみ。
  `entries` が空ならチャンク全体を削除する(基底復帰、TS側の削除規則と同じ)。
- タイル生成時(`create_gpu_tile`)に、そのタイルが実際にサンプルする範囲へ重なる
  オーバーライドだけを `build_tile_overrides` で local_index 昇順のソート済み配列
  `[local_index0,height0,local_index1,height1,...]` へ変換し、専用のストレージバッファ
  (`tile_bgl` binding=2、read-only storage)へ載せる。`tile_generate.wgsl` は自分の
  local_index(`i=lx*grid_size+lz`)をこの配列に対して**二分探索**し、ヒットしたら
  ベース地形の代わりにその高さを使う(`override ?? base`、createEditedTerrainField と
  同じ意味論)。1タイルあたりの上限は `MAX_TILE_OVERRIDES=16384`(現実的な編集規模に対し
  十分な余裕。二分探索なので上限を大きく取ってもシェーダコストはほぼ変わらない)。
- 転送は「変更のあったチャンクだけ」(overlayChunkRefsと同じ参照比較トリック、
  `WebGpuTerrainLayer.tsx` の `pushChangedChunks`)。wasm側は受け取ったチャンクを
  `invalidate_chunk` で該当しうる常駐タイル(全LOD、スナップ許容込み)だけキャッシュから
  外し、次の `render()` 呼び出しで(通常フレームの visible/needed 選択に載れば)
  即座に再生成する。

### LOD一貫性規則

- **LOD0(stride=1)は厳密一致のみ**採用する(`Math.round`+完全一致という
  createEditedTerrainField の契約そのもの)。edit_check の「0 mismatches」判定はこの
  LOD0の一致だけを正しさの契約として課す。
- **LOD>0(stride>1)は最も近い格子点(世界座標で±stride/2以内)へスナップ**して適用する。
  スナップしないと、粗いLODが編集コーナーをそもそもサンプルせず、遠景ズームで編集地形が
  「消える」ため。複数の編集コーナーが同じ粗いサンプル点へスナップする場合は距離が最も
  近いものを採用し、同距離なら x→z 昇順で決定的にタイブレークする(HashMapの走査順に
  依存しない。A8: 同一シード・同一カメラ経路での出力バイト一致に必要)。
  `renderer/renderer_wgpu/src/lib.rs` の `edits::tests`(5件)がこの規則を固定している。

### A3(地形編集差分の反映コスト・正しさ)

ネイティブバイナリ `renderer/renderer_wgpu/src/bin/edit_check.rs` を追加し、
`run-layer-a.mjs` の `A3` / `A3_overlay_update` ゲートへ配線した(既存の
tile_check/noise-check と同じ Vulkan バックエンド前提、層AのVMで走る)。

- 正しさ: 5タイル×300コーナーのランダム編集(xorshift32、決定的)を CPU リファレンス
  (`override ?? base`)と GPU 経路(build_tile_overrides→二分探索)の両方に適用し、
  影響ウィンドウ(257×257 コーナー)全点を比較。開発機(Apple M4、Metal backend で
  一時的に検証、Vulkanが無い開発機のため)で実測: **5タイル・330,245点・不一致0件**。
- CPU側コスト: `set_corner_override_chunk` 相当(HashMap構築+`build_tile_overrides`)を
  1万回計測。実測値(Apple M4): **中央値 0.0075ms / p99 0.0104ms**(目標 ≤1ms を大幅に
  下回る)。
- 層AのVM(Vulkan software rasterizer)での実行は本セッションでは未実施(このMac開発機に
  Vulkanローダが無いため noise-check/tile_check と同様に走らない、既知の環境制約)。
  CI/層A環境では他の check バイナリと同じ手順(`cargo build --release --bin edit_check`→
  実行)でそのまま動く設計にしてある。

### T8(地形編集の反映フレーム数)

ブラウザ(port 5175、WebGPUモード)で `window.__webgpuLayer.syncAndRender` を直接
同期呼び出しする方法で実測した(非表示タブでは rAF が止まる制約があるため、
CLAUDE.mdの手動tick方針に倣い rAF 経由の計測は使わなかった)。

- 定常状態から `pushCornerOverrideChunk` を呼んだ**直後の次の `render()` 呼び出し1回で
  `generatedTiles:1`(対象タイルの再生成)を確認**。実測 `elapsedMs≈0.4ms`。
  実際のゲームは `syncAndRender` を毎フレーム(useFrameから)1回だけ呼ぶので、
  これは**編集を適用したフレームの次に描く1フレームで反映される**ことを意味する
  (目標 ≤1フレームを満たす。非同期compute化はしていないため、同期GPU経路のまま
  規定値を満たせている)。

### 地下ビュー減光の同調

- `terrain_draw.wgsl` の `CameraParams` 末尾の未使用 `_pad` フィールドを `dim:f32` として
  再利用した(バイト長・バインディング形状は不変なので、他の check バイナリの camera_bgl
  定義には影響しない。dimを実際に使う lib.rs / layer_b_bench.rs のみ書き込み値を
  `1.0`(通常表示)に更新)。`dim` は頂点シェーダで `Out.dim` として運び、
  フラグメントシェーダで `color*dim` として乗算する(このパイプラインは
  `blend:None` の不透明描画のため、three.js の DIMMED_MATERIALS のようなアルファ合成では
  なく色の直接減光で見た目を揃える)。
- wasm API `setDim(factor)` を追加。`WebGpuCameraSync`(`WebGpuTerrainLayer.tsx`)が
  毎フレーム `isLevelDimmed(0, undergroundView, buildLevel) ? 0.3 : 1` を渡す
  (`WEBGPU_UNDERGROUND_DIM_FACTOR=0.3`、three.js DIMMED_MATERIALS の
  `opacity:0.3` に合わせてスクリーンショット比較で選定)。
- ブラウザ実機で確認: 建設レベルを「地下1」へ切り替えると、wgpu地形が three.js の
  地下ビュー演出と同時に暗く落ちることを確認した(GameScene側のisLevelDimmed呼び出しと
  同じフレームで setDim が呼ばれるため、両層は同調して切り替わる)。

### 設定パネルの文言更新

「地形編集(盛土/切土)の結果が反映されない」という R1 時点の記述を削除し、
「地形編集の結果も反映されるが、地形に影はまだ落ちない」に更新した(`GameUI.tsx`)。

### 既知の制約・次フェーズへの持ち越し

- `MAX_TILE_OVERRIDES=16384` を超える極端な編集(1タイルの1/4以上のコーナーを
  1回で編集するような操作)は、local_index昇順で先頭から採用されるため一部が
  反映されない可能性がある(現実的な操作では到達しない上限だが、無制限ではない)。
- edit_check の層A(Vulkan VM)実行は本セッションでは未検証(開発機にVulkanローダが
  無いため)。次回層A環境が使える時に `node renderer/bench/run-layer-a.mjs` を通し、
  A3ゲートの実測値をVM側でも取ること。
- LOD>0のスナップは「見た目上消えない」ことを目的とした近似であり、遠景での編集の
  正確な位置一致は契約に含めていない(LOD一貫性規則の節を参照)。
