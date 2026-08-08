# R4: three.js 全面退役計画(wgpu 一本化)

## Decision

R1〜R3 の二層合成(wgpu 地形 + three.js 上層)から、**上層の全描画物を wgpu へ移管し
three.js / react-three-fiber / drei を依存から外す**。

基本方針は **「ジオメトリ生成は TS に残し、wgpu は描画装置に徹する」**:

1. **メッシュチャンク API**(新設): TS 側が今までどおり trackGeometry.ts /
   townTiles / Scenery のロジックでジオメトリを生成し、`位置(f32x3)+頂点色(unorm8x4)`
   の平坦な配列としてバケット単位で wasm へアップロードする。wgpu は
   カメラ uniform(既存 bind group 1)で描くだけ。
   - 理由: レールと列車の位置整合は「同じ TS ベジェ(trackPath.ts)を使う」ことで
     保証されている。Rust へジオメトリ生成を移植すると整合の橋が二重になり、
     正しさの検証コストが跳ね上がる。ボトルネックは地形(移管済み)であり、
     ジオラマ物の CPU 生成は現行 three.js でも実用速度が出ている
2. **インスタンス描画 API**(新設): 列車専用。プロトタイプメッシュ(車両モデル)を
   登録し、毎フレーム `原点+ヨー+ピッチ+路線色` のインスタンス配列を更新する。
   位置は既存の純関数 `carPositions()`(consist.ts)をそのまま使う
3. **照明**: three.js のライト+動的影は廃止。TS 側のジオメトリ生成時に
   **面単位ランバート陰影を頂点色へ焼き込む**(光方向は現行 SunLight と同じ)。
   動的影は v1 では非対応(既知のビジュアル差として記録)
4. **カメラ**: wgpu `CanvasRenderer` が真実源になる(pan_pixels/zoom_by は実装済み)。
   OrbitControls は素の pointer/wheel ハンドラで置換。可視チャンク計算
   (CameraChunkTracker)は webgpuCamera.ts の閉形式で再実装
5. **ピッキング**: `projectToScreenPx` の逆関数(閉形式)で screen→セル。
   地形編集時は高さ候補を上から走査して最初に合うセルを取る。列車クリックは
   画面空間 AABB 判定(先頭車を投影して矩形判定)。GPU 往復なし(T13)
6. **HTML ラベル**(駅名・町名・列車ツールチップ): drei `<Html>` を廃止し、
   `projectToScreenPx` で毎フレーム座標を出す素の DOM オーバーレイに置換
7. **classic モード(three.js 地形)と rendererPreference は削除**。WebGPU 非対応
   環境には案内画面(Chrome/Edge/Electron を促す)。wasm 未ビルド時は開発向けに
   `npm run build:renderer` を促すエラー画面
8. **地下ビュー**: 地表バケットを dim 係数で減光(地形と同じ)、地下バケットを
   深度無視で上描き。three.js の「透明度0.3の被せ」は再現しない(近似で可、
   WebGPU モードの現行地形挙動と統一)

## フェーズ分割

- **R4a**: wgpu にメッシュチャンク+インスタンスの2パイプライン追加(Rust/WGSL)、
  TS ブリッジ(webgpuLayer 拡張)、木と町タイルを移管して実証。陰影焼き込み共有関数
- **R4b**: レール網(高架桁・坑口・橋・掘割含む)、駅・車庫・信号を移管。
  地下ビュー規則・レイヤ別表示・farView 予算の移植
- **R4c**: 列車(インスタンス)、建設プレビュー・カーソル、glb インポータ+
  バリデータ(progress/train-model-format.md 準拠)、DOM ラベルオーバーレイ
- **R4d**: カメラ所有権移管・閉形式ピッキング・SimulationDriver の素 rAF 化・
  three/r3f/drei 依存削除・classic モード削除・デバッグフック維持
  (__dbgStep/__debugWorld ほか)・両ゲート+ブラウザ検証・版数更新

各フェーズ完了時に: `npm run test` + `npm run build` + wasm ビルド + ブラウザ目視検証。
renderer/ に触れたフェーズは **層A(VM)・層B(Mac)両ゲート必須**。

## Alternatives considered

- **ジオメトリ生成ごと Rust/GPU へ移植**: 棄却(v1)。レール=列車の整合橋が二重化し、
  16K でも生成コストは地形以外軽いため利益が薄い。将来の最適化余地として残す
- **three.js を非対応環境フォールバックとして残す**: 棄却。二重実装の維持費が高く、
  対象環境(Chrome/Edge/Electron)は WebGPU 安定版。ユーザー判断で全退役
- **GPU ピッキング(IDバッファ読み戻し)**: 棄却。クォータービューは閉形式で足り、
  T13(≤0.1ms)も閉形式でしか満たせない

## Constraints / Gotchas

- ドローコール: バケット×可視範囲で数十。T11(≤30)はベンチシーン基準を維持しつつ、
  ゲーム実描画では「カテゴリ毎に1バッファプール+チャンク範囲描画」で抑える
- 透過が要るのは 建設プレビュー(0.45)・ホーム扉ガラス(0.55)のみ。
  半透明バケットは深度書き込みなしで最後に描く
- 列車選択マーカー・経路ドットもインスタンス描画で出す(専用小メッシュ)
- デバッグフックの互換: __dbgStep/__debugWorld は維持必須(検証手順が依存)。
  __camera/__orbitControls は廃止し __webgpuCamera(centre/zoom読み書き)へ置換、
  CLAUDE.md の検証手順を更新すること
- 電車モデルの正式フォーマットは progress/train-model-format.md。R4c 完了までは
  現行プレースホルダ形状を TS でインスタンス用メッシュとして生成して使う

## R4a 実装メモ(0.4.0-Alpha-4a)

### 追加した wasm API(`CanvasRenderer`)

```
uploadMeshChunk(id: u32, layerClass: u32, aabb: &[f32;6],
                positions: &[f32], colours: &[u32], indices: &[u32])
removeMeshChunk(id: u32)
registerInstancedMesh(meshId: u32, positions: &[f32], colours: &[u32], indices: &[u32])
setInstances(meshId: u32, data: &[f32])
```

- `layerClass`: 0=地表(dim uniform で減光、深度 LessEqual+書き込み) /
  1=地下(深度 Always・深度書き込み無し。`dim==1.0`(=地下ビューでない)のとき
  CPU 側で丸ごと描画を省く) / 2=半透明(αブレンド・深度書き込み無し・最後に描く。
  αは頂点色のA)
- 頂点は `位置 f32x3 + 頂点色 unorm8x4` の stride 16。インデックスは u32
- `aabb` は `[minX,minY,minZ,maxX,maxY,maxZ]`(y はワールド単位)。毎フレーム
  等角投影の閉形式で画面矩形へ落としてビューポートと判定する(`projection::aabb_visible`)
- インスタンスは **10 f32 = 40 バイト固定 stride**:
  `[x, y, z, yaw, pitch, tintR, tintG, tintB, flags, 予約]`。
  `flags` bit0 で地下クラス。パイプライン状態はドロー単位でしか変えられないので、
  クラス振り分けは `setInstances` 時に CPU 側で2本のバッファへ分ける
- インスタンスの **tint 規約**: 頂点色のアルファを「路線色を掛ける重み」として使う
  (a=255 → `頂点色 × tint`、a=0 → 頂点色そのまま、中間は線形補間)。
  メッシュチャンクの半透明クラスとはアルファの意味が違う点に注意

描画順は 地形 → 地表チャンク → 地表インスタンス → 地下チャンク → 地下インスタンス →
半透明チャンク。深度バッファは既存の Depth32Float を共有する。
`render()` の統計JSONに `meshChunks` / `meshDrawCalls` / `instancedMeshes` /
`instancedDrawCalls` を追加した(`drawCalls` は従来どおり地形タイルのみ)。

### 計画からの逸脱・補足

- **投影式の共有**: メッシュの y はワールド単位だが、地形シェーダの `project()` は
  y が段数単位。深度式を完全一致させるため、シェーダ内で
  `y_levels = y_world * ppc * ISO_H / height_scale` と戻してから同じ式に入れている。
  これをやらないと地表に置いた木が地形に食われる
- **陰影の焼き込み**(`src/render/bakedMesh.ts`): 面の外積をそのまま法線に使い、
  `AMBIENT 0.2 + HEMI 0.28×(0.5+0.5·ny) + SUN 0.55×max(0, n·L)` を頂点色へ掛ける。
  光方向は GameScene の SunLight(position=[-30,34,14])の正規化。色は three.js と
  同じく16進のsRGB値をそのまま使う(wgpu 地形も PALETTE の値をそのまま書いている)
- **バケット統合**: 頂点色を持つのでマテリアル別にメッシュを分ける必要が無く、
  樹木3バケット・町7バケットをそれぞれ1チャンク=1ドローに畳んだ
- **チャンク単位**: 樹木は可視チャンク(32セル)ごと、町は町1つごと。
  `useMeshChunkFeeder`(1フレーム最大6チャンク構築)が可視集合との差分で載せ替える
- **地下ビューの減光**は wgpu の dim uniform が地形ごと担当するため、焼き込み側の
  減光係数は遠景フェード(farView の 'dimmed' 段階)専用にした
- **ネイティブ検証バイナリ** `mesh_shader_check` を追加。5本のパイプラインを実デバイスで
  組み、1x1読み戻しで「地表のdim減光・地下クラスがdimを無視すること・インスタンスtint」を
  検証する(ブラウザ不要。Mac/Metal で全項目 pass)
- **ブラウザ検証で見つけた不具合**: `WebGpuTerrainLayer` は seed/halfExtent をキーに
  マウントし直されるため、新規ワールド生成・セーブ読込のたびに `CanvasRenderer` が
  別インスタンスになる。フィーダはコントローラの同一性を監視して台帳を作り直す必要がある

### ゲート結果

- **層B(Mac / Apple M4 / Metal、3回計測)**: T1〜T7 のプロトタイプ閾値は3回とも全pass。
  中央値run(worst-phase p99基準)では strict も全pass。
  T1 median 0.620/0.630/0.635 ms・p99 3.768/4.028/3.274 ms、T2 median 0.336〜0.352 ms、
  T3 hitch 0/10260(3回とも)、T4 median 2.05〜2.21 ms・p99 6.99〜8.90 ms、
  T5 zoom hitch 0、T6 firstFrame 6.7〜11.4 ms。新パイプラインは空シーンでは
  ドロー0本のため、地形ベンチへの影響は無い
- **層A(VM / llvmpipe / Vulkan)**: `node bench/run-layer-a.mjs --browser-exact --check-ts-migration`
  を実施し、**判定対象のゲートは全pass**(`pass:null` は層B専用ゲート)。
  build は workspaceTests / nativeBins / productionTsVsRust1M / wasmPack / vite すべて true。
  A1 median 0.000099 ms・p99 0.000173 ms、A2 0.000837 ms/tile、A3 mismatches 0・
  CPU diff median 0.0095 ms、A5/T10 heap 1,245,184 B(上限 96 MiB)、A6/T15 wasm gzip
  86,816 B(上限 1 MiB)、A7 hitch 0、A8 決定性 true、T4/T11 drawCalls 9(上限24)、
  T6 firstFrame 56.7 ms、T14 5シード×1000万点 mismatch 0、
  A4 browser-exact(BrowserWebGPU 読み戻し)mismatch 0、cameraReplay 3回とも ok
- **`mesh_shader_check`**: Mac(Metal / Apple M4)・VM(Vulkan / llvmpipe)の両方で
  5パイプライン構築+4項目の読み戻し検証が pass
  (地表 dim=1.0 → (255,0,0)、dim=0.3 → (77,0,0)/(76,0,0)、地下クラスは dim 無視、
  インスタンス tint で白→緑)

### 次フェーズ(R4b)への申し送り

- レール網・駅・車庫・信号は同じ `useMeshChunkFeeder` に載せられる。地下レイヤーは
  `MESH_LAYER_CLASS.underground`、ホーム扉ガラス・建設プレビューは `translucent`
- 町名ラベル・駅ラベルはまだ drei `<Html>` のまま(R4c で DOM オーバーレイへ)

## R4b 実装メモ(0.4.0-Alpha-5a)

### 移管した範囲

TrackNetwork(レール網・高架桁/橋脚/橋台・掘割開口)・StationBlock(ホーム・駅舎)・
DepotBlock・SignalBlock・トンネル坑口(GameScene 内 JSX + tunnelPortalGeometry.ts)・
水上橋(GameScene 内インライン JSX)のすべてを WebGPU モードで wgpu メッシュチャンクへ
移管した。classic(three.js)モードは無変更(見た目・挙動とも従来どおり)。

### 配置ロジックの一次情報源(重複させない設計)

R4a の方針どおり「ジオメトリ生成は1箇所、描画先(three.js JSX / wgpu 焼き込み)だけ
分ける」を徹底した:

- `src/render/railGeometry.ts` の `buildRailNetworkGeometry()` — 旧 `TrackNetwork.tsx`
  の `useMemo` 本体をそのまま抽出した純粋関数。`TrackNetwork.tsx`(three.js)と
  `WebGpuTrackNetwork.tsx`(wgpu)の両方がこれを呼ぶ
- `src/render/stationGeometry.ts` の `buildPlatformSideGeometries`/
  `buildStationCellGeometries`/`buildStationHouseGeometries` — ホーム・駅舎の形状を
  ワールド座標の `THREE.BufferGeometry` として生成する。寸法定数(`PLATFORM_HEIGHT`等)は
  `components/StationBlock.tsx` から export し、そちらを一次情報源として import する
  (数値の二重管理を避ける)。駅舎の配置計算(地平/高架/地下のどのセルに置くか、
  向き、隠すかどうか)は `src/render/stationLayers.ts` の
  `computeStationHousePlacement()` へ抽出し、`GameScene.tsx` の classic 分岐
  (`<StationHouse>` 呼び出し)と `WebGpuStations.tsx` の両方がこれを共有する
- `src/render/depotGeometry.ts` / `signalGeometry.ts` / `tunnelPortalMeshGeometry.ts` /
  `waterBridgeGeometry.ts` — DepotBlock/SignalBlock/坑口/水上橋は形状が小さく
  固定的なため、寸法は各 JSX(classic 側、退役予定)からそのまま複製した。
  R4d で classic 側ごと削除されるため、これ以上の共有化コストは掛けていない
  (progress メモに明記して判断根拠を残す)

### バケット・キーイング方針

- **レール網**: `railMap` 全体を1回で計算し、`surface`(常時)/
  `undergroundBright`(選択中の地下レベル)/`undergroundDim`(非選択の地下レベル)の
  3キーだけを扱う。3つとも独立した `useMeshChunkFeeder` インスタンス
  (= 独立した `MeshChunkRegistry`)にした。理由: layerClass が異なるチャンクは
  1つのフィーダで混在できない(chunk id 空間はフィーダごとに閉じているため、
  同じ namespace を複数フィーダで共有すると id が衝突する — 実装中に発見し、
  信号の地面マーカー用フィーダで同じ問題を踏んだため `signalMarker` 名前空間を
  追加して回避した)
- **駅**: 駅idごとに `surface`/`glass`/`undergroundBright`/`undergroundDim`/`house`の
  最大5チャンク。ガラス(ホームドア)は全レベル合算で1チャンクにまとめ、
  alpha=0.55×255固定(下記「既知の視覚差」参照)
- **車庫・信号・坑口・水上橋**: `railMap`/`tunnelPortalList` 全体を1チャンクずつに
  まとめた(`WebGpuTrackExtras.tsx`)。個体数は player-built でスパースなため、
  セルごとに分割する必要がない
- **id 名前空間**: `render/meshChunkRegistry.ts` の `MESH_CHUNK_NAMESPACE` に
  `railSurface`/`railUndergroundBright`/`railUndergroundDim`/`station`/
  `stationGlass`/`stationHouse`/`stationUndergroundBright`/`stationUndergroundDim`/
  `depot`/`signal`/`signalMarker`/`tunnelPortal`/`waterBridge` を追加
  (先頭ビットで 0x0100_0000 刻みに区切り、衝突を防ぐ)

### 地下ビューの明暗(3クラスでの近似)

wgpu 側は layerClass が3つ(surface/underground/translucent)しかなく、three.js の
「地表全体を dim uniform で一括暗化」+「地下は選択レベルのみ通常輝度、それ以外は
`DIMMED_MATERIALS`(opacity 0.3、ガラスのみ 0.14)」という2階層の明暗をそのままは
表現できない。以下の近似で対応した(plan の想定どおり):

- **地表(level>=0)**: レベルに関わらず layerClass=surface のまま。理由は
  three.js 側の `isLevelDimmed(level>=0, undergroundView, selectedLevel)` が
  「selectedLevel は地下ビュー中つねに負」なので、level>=0 のコンテンツは
  地下ビュー中は**必ず** dimmed=true になる。つまり地表は「地下ビューかどうか」
  だけで一律に暗くなり、レベルごとの個別判定は元から不要だった。wgpu の
  dim uniform(地形と共通)がこれを過不足なく再現する
- **地下(level<0)**: 選択中のレベルは layerClass=underground(深度無視・不透明)、
  非選択レベルは layerClass=translucent に alpha≈0.3×255(≈76)を焼き込んで
  `DIMMED_MATERIALS` の opacity 0.3 を近似した
- **既知の視覚差**: 駅のガラス(ホームドア)は3レベル分(surface/underground
  bright/dim)を1チャンクに合算しているため、three.js のように「非選択地下では
  ガラスだけ opacity 0.14 まで下げる」区別をしていない。すべて alpha=0.55 固定。
  影響は小さい(ガラス自体が細い面積)ため、v1 はこの近似で確定した

### 発見した実装上の注意点

- **メッシュチャンクの id 名前空間はフィーダ単位**: `useMeshChunkFeeder` は
  呼び出しごとに独立した `MeshChunkRegistry`(`useRef` で保持)を持つため、
  同じ `namespace` を2つのフィーダ呼び出しで使うと、両方が `base+0` から
  id を払い出して衝突する。1つのコンポーネント内で複数の
  `useMeshChunkFeeder` を呼ぶ場合は、必ず異なる namespace を渡すこと
- **座標変換のクリック検証Tips(このセッションで再確認)**: ブラウザの
  `computer` ツールの click/hover 座標は、`window.__camera`(THREE.OrthographicCamera)
  の `position.clone().project(camera)` で得た CSS ピクセル座標を **1.6 で割った値**
  (`getBoundingClientRect()` の CSS 幅 1280 に対しスクリーンショットは 800、
  1280/800=1.6)。zoom を変更した直後は必ずこの換算をやり直すこと
  (本セッションでは zoom を 90 に変えた後に古い換算を使い回して2回クリックを外した)

### ブラウザ検証

- WebGPU モードで地平の線路(直線+橋)・駅(ホーム床/側壁/点字ブロック/上屋/柱+駅舎)・
  信号(支柱/灯器/矢羽根)・水上橋(桁+橋脚)を実際に建設し、スクリーンショットで
  classic モードと並べて配色・配置が一致することを確認した
- 地下ビュー(建設レベルを「地下1」に切替)で地表(周囲の地形・線路・駅舎すべて)が
  一括で暗くなること(dim uniform)を確認。地下セグメント自体(uppers[-1])が
  `railMap` に正しく登録されること(rampの自動接続込み)を `__debugWorld` で確認
- classic ⇄ WebGPU のレンダラー切替を複数回往復し、クラッシュ・空白化がないことを確認
  (切替直後に一度「Rendered more hooks than during the previous render」系のエラーが
  コンソールに残っていたが、これは実装中の Vite HMR(コード編集を同一セッションの
  ブラウザに反映)由来のスナップショットで、ページを再読み込みした新規セッションでは
  同じ操作を繰り返しても再発しなかった。実装バグではなく開発中の HMR アーティファクト
  と判断した)
- `npm run test`: 829件全て green(既存の16Kマップ性能ガード2件はこのセッションの
  マシン負荷変動でのみ間欠的に落ちる既知のフレーク。`src/sim/**` は今回未変更)
- `npm run build`: 型検査込みで green。`renderer/` は今回変更していないため、
  層A/層Bゲートの実施は不要(タスク条件どおり)

### 次フェーズ(R4c)への申し送り

- 列車(インスタンス描画)・建設プレビュー・カーソル・DOM ラベルオーバーレイが残課題
- DepotBlock/SignalBlock/坑口/水上橋の寸法は classic 側 JSX と複製したままなので、
  R4d で classic 側を削除する際にこれらのハードコードされた数値をどちらか一方
  (wgpu 側)に一本化すること

## R4c 実装メモ(0.4.0-Alpha-6a)

### 移管した範囲

列車(インスタンス描画)・列車クリック選択(スクリーン空間判定)・駅名/町名/選択列車
ツールチップ(DOM オーバーレイ)・建設プレビュー/列車ドラッグ配置ゴースト(メッシュ
チャンク)を WebGPU モードへ移管した。加えて progress/train-model-format.md 準拠の
glb インポータ+バリデータのツールチェーンを新設した。classic(three.js)モードは
無変更。

### 1. 列車のインスタンス描画

- `src/render/trainInstanceMath.ts`: `DynamicTrain.tsx` に private だった
  `carGroupPosition`/`RAIL_SUPPORT_OFFSET` を抽出し、classic/WebGPU 両方の描画
  パスが同じ計算を共有する(レール=列車の整合を保つ設計方針どおり)。
  `headingToYawPitch` は `mesh_instanced.wgsl` の頂点変換(ピッチ→ヨーの順に回転)
  を逆算した式(`yaw=atan2(hx,hz)`, `pitch=atan2(-hy,hypot(hx,hz))`)で、
  three.js の `lookAt` と同じ向きになることをテストで検証した(回転式をJSで
  再現してheadingへ一致するか確認する round-trip テスト)。
- `src/render/trainMeshBuilder.ts`: `TrainCar.tsx` のプリミティブ構成(台車・床下
  機器・車体・窓帯・ラインカラー帯・屋根・クーラー・前面)を複製し、位置+頂点色
  (陰影焼き込み+tint重み)の静的メッシュとして1回だけ焼き込む。ラインカラー帯だけ
  alpha=255(路線色でtint)、他はalpha=0。**逸脱**: three.js版は前照灯/尾灯を
  variant(front/rear)ごとに片方だけ生やしていたが、こちらは car_head 1種を
  180°回転してtail流用する都合上、前後どちらの妻面にも前照灯(+Z)・尾灯(-Z)を
  同時に持たせた(train-model-format.md の「180°回転流用で丁度良くなる」という
  想定を先取りした形。将来 glb モデルを納品する際もこの前提で作ればよい)。
  選択マーカー(逆三角錐)・経路ドット(八面体)は白ベース全面tint(alpha=255)で
  作り、tint色をそのまま最終色にできるようにした。
- `src/components/WebGpuTrains.tsx`: 起動時(コントローラ生成/差し替え検知)に
  head/mid/選択マーカー/経路ドットの4メッシュを`registerInstancedMesh`、
  毎フレーム`InstanceBuffer`(伸長可能な使い回しFloat32Array)へ書き込んで
  `setInstances`。tunnel非表示・ドラッグ持ち上げ・先頭/最後尾判定(最後尾は
  yaw+πでhead流用)を再現した。
  **既知の視覚差(地下ビューの非選択レベル)**: wgpu のインスタンスAPIは
  flags bit0 でしか描画クラスを分けられず(surface/underground の2値、メッシュ
  チャンクのtranslucentクラスに相当するものが無い)、three.js版の「非選択の
  地下レベルを半透明で暗く見せる」表現ができない。そのため非選択地下レベルの
  車両は描画そのものをスキップする近似にした(WebGpuTrackNetwork等の3クラス
  近似とは異なる簡略化)。
  **既知の簡略化(ドラッグ中の向き)**: three.js版はドラッグ中も直前の回転を
  保持するが、インスタンスは毎フレーム作り直すため常にyaw=0(常に+Z向き)で
  描く。ドラッグは短時間の操作で見た目の影響は小さいと判断した。

### 2. 列車クリック選択(スクリーン空間ピッキング)

- `src/render/trainPicking.ts`: `pickTrainAtScreenPoint(candidates, cursor,
  camera, radius)` — `projectToScreenPx`で先頭車を投影し、半径内で最も近い候補を
  選ぶ純粋関数(GPU往復なし、T13方針の先取り)。
- `GameScene.tsx`の`handleClick`(`buildMode==='none'`)に`pickTrainInWebGpuMode`を
  追加。地面プレーンのクリック位置(`clientX/clientY`をcanvas矩形とDPRで物理
  ピクセルへ変換)と、`carPositions(...,1,...)`で求めた各列車の先頭車位置を
  照合する。three.js側のpickingはR4dまでGameSceneが握ったままなので、
  webGpuLayerモードの間だけこの経路を使う(mission指示どおり「簡単なスクリーン
  空間AABB判定」として実装、閾値半径22物理px)。

### 3. DOM ラベルオーバーレイ

- `src/render/labelOverlay.ts`: `worldToOverlayPx(world, camera, dpr)` —
  `projectToScreenPx`の物理ピクセル出力をCSSピクセルへ戻し、コンテナ左上原点の
  座標に変換する純粋関数。`isOnScreen`で画面外判定(マージ80px)。
- `src/components/LabelOverlay.tsx`: Canvasの**外側**(App.tsx)に置く素の
  `<div position:absolute>`。rAFループで各項目のrefへ直接`style.transform`を
  書き込み、位置更新のたびにReactの再レンダーを起こさない(中身=contentが
  変わったときだけ通常のReact再レンダーで追従する設計)。
- `App.tsx`: `webgpuCameraStateRef`(`WebGpuCameraSync`が毎フレーム書き込む)を
  `GameScene`へ渡し、`GameScene`は自前で持っていたローカルrefの代わりにこれを
  使う(列車クリック判定とLabelOverlayが同じフレームのカメラ状態を共有する)。
  駅の待ち人数・選択列車の速度/状態は`worldRef.current`を0.5秒間隔でポーリング
  して`labelItems`を再構築する(StationLabel/DynamicTrainのHtml版と同じ更新
  頻度、r3fのuseFrameには乗せない)。
  **既知の簡略化**: 駅ラベルのY座標は`computeStationHousePlacement`の
  `labelY`(高架駅で上屋にめり込まないよう調整済み)を使わず固定値1.35にした
  (App.tsxはCanvas外にあり、駅ごとの配置計算をここで再実行するコストを避けた)。
  停車順バッジ(選択列車の運行表に含まれる駅への①②表示)も同様に省略した。
  どちらも見た目の主要な情報(駅名・待ち人数・列車速度)には影響しない。
- `GameScene.tsx`: `webGpuLayer`のとき`<StationLabel>`(drei Html)を出さない、
  `<TownLabels>`の明示呼び出しをやめる(`TownBlocks`内部のTownLabelsは
  classicのみ経由するので二重表示にならない)。

### 4. 建設プレビュー・列車ドラッグ配置ゴースト

- `src/components/WebGpuBuildPreview.tsx`: 半透明ボックス(alpha=0.45×255)を
  メッシュチャンク(`MESH_LAYER_CLASS.translucent`)として描く。`cells`
  (建設プレビュー)と`dragCell`(列車ドラッグ配置ゴースト)それぞれに固定の
  チャンクidを1つずつ割り当て、内容の署名文字列(座標+色の連結)が変わった
  フレームだけ`uploadMeshChunk`し直す(`useMeshChunkFeeder`は複数キーの差分
  管理が主目的で今回は単一チャンクなので使わず、直接呼び出しにした)。
- **意図的な簡略化**: classicの地平レールプレビュー(`buildMode==='rail'
  &&buildLevel===0`)は`RailBlock`(バラスト・枕木・レールの実ジオメトリ)を
  出すが、wgpu版は他のケースと同じ半透明ボックスに統一した。GameScene.tsx
  自身がこの分岐を「確定前プレビューはシンプルに」と位置づけていた
  (既存コメント「design memo『keep it simple』」)ことを踏まえた判断。
- `GameScene.tsx`: `previewPath`から`previewGhostCells`(色・高さ計算はclassicの
  JSX分岐と同じロジック)を`useMemo`で構築し、`webGpuLayer`のときは
  classicの`<mesh>`オーバーレイ(建設プレビュー・列車ドラッグゴーストの両方)を
  出さずに`<WebGpuBuildPreview>`だけをマウントする。

### 5. glb インポータ+バリデータ

- `renderer/tools/glbLib.mjs`: 依存なしの最小glTF2.0バイナリパーサ(Node向け、
  Bufferベース)。JSON/BINチャンク分離・アクセサ読み出し(componentType別・
  bufferView.byteStride対応)・ノード変換(matrix優先、無ければTRSから合成)・
  ノード配下(子孫含む)の三角形数/AABB/モーフ使用の集計。
- `renderer/tools/validate_train_glb.mjs`: train-model-format.md 準拠のCLI検査
  (`node renderer/tools/validate_train_glb.mjs <path>`)。glb解析可否/必須ノード
  (car_head, car_mid)存在/三角形数上限(本体500・lod1系80)/寸法制約(全長Z<=0.92・
  全幅X<=0.50・全高Y<=0.60)/y<0ジオメトリなし/テクスチャ・スキン・アニメーション
  不使用をチェックし、項目ごとにPASS/FAILを出力する(exit code 0/1)。
- `src/render/trainModelLoader.ts`: ブラウザ実行時ローダ。`glbLib.mjs`と同種の
  パーサをArrayBuffer/DataView(ブラウザ環境)向けに独立実装した(Node Bufferには
  依存できないため)。`public/models/trains/<id>.glb`をfetchし、`car_head`/
  `car_mid`ノードを平坦化した三角形スープへ`bakedMesh.ts`の陰影焼き込みで変換
  する。マテリアル名`line_colour`の面はalpha=255(tint重み)、他はalpha=0。
  取得失敗・解析失敗・必須ノード欠如は`null`を返し、呼び出し側
  (`WebGpuTrains.tsx`)が`trainMeshBuilder.ts`のプレースホルダへフォールバック
  する。`TRAIN_MODEL_REGISTRY`(車種id→glbモデルid)は現時点で空(実モデル
  未納品のため、登録するだけで自動的に使われる設計)。
- テストは`renderer/tools/glbTestFixtures.mjs`でメモリ上に合成glbを組み立てて
  検証する(実ファイル不要)。`vitest.config.ts`の`include`に
  `renderer/tools/**/*.test.mjs`を追加した。

### ブラウザ検証

- WebGPUモードでデバッグシナリオ(坂・高架・往復列車)を読み込み、`__dbgStep`で
  進めた列車が線路に沿って正しい位置・向き(カーブ含む)・路線色帯で描画される
  ことをスクリーンショットで確認。列車クリック選択(スクリーン空間判定)で
  選択マーカー(頭上の逆三角錐)・経路プレビュードット(黄色)・DOMツールチップ
  (id・速度・状態)が表示されることを確認した。
- 駅名ラベル(A駅/B駅、待ち人数表示)がDOMオーバーレイで正しく追従することを
  確認。
- 線路(rail)ツールでドラッグして建設プレビュー(半透明ボックス、コスト表示)が
  wgpuメッシュチャンク経由で正しく表示されることを確認した。
- classicモードへ切り替えて同じデバッグシナリオを読み込み、駅ラベル(drei Html)
  が従来通り表示されることを確認(無変更であることの確認)。
- **セッション中に踏んだハマりどころ**: ブラウザ自動操作ツールの`computer`
  クリック座標は「スクリーンショットのピクセル空間」(本セッションでは
  800×450、実ビューポート1280×720なので**実CSS座標の1/1.6**)であり、
  ボタンなど`ref`経由のクリックは要素の実CSS座標を自動計算するため両者の
  座標系が異なる。これに気づかず生CSS座標をそのまま渡して列車選択・線路敷設の
  クリックが1/1.6だけズレて外れ続けた(結果的に「新規ゲーム開始モーダルが
  閉じない」ように見えた誤診断も発生した)。実際のモーダルクローズ処理
  ([`App.tsx`](../src/App.tsx)の`setShowStartupOptions(false)`)自体には
  問題が無く、原因はクリック座標の誤りだった。今後このツールで列車・地面の
  精密クリックを行う際は、`window.__camera`/`__orbitControls`とworld座標から
  `webgpuCamera.ts`と同じ投影式でCSS座標を計算し、**さらに1.6で割った値**を
  `computer`のcoordinateへ渡すこと(CLAUDE.mdの「クリック座標は screenshot の
  1/2」という既存の記述はツール・セッションによって比率が異なりうるので、
  実際にはその場で`document.querySelector('canvas').getBoundingClientRect()`
  と`Screenshot size`の比を確認するのが確実)。

### 未着手・今後の課題(R4d への申し送り)

- 地下ビュー中の列車(選択レベル以外)の減光表現(現状は非表示で近似)を、
  インスタンスAPIへ3クラス目(translucent相当)を追加するなどして改善する余地
  がある(rustのInstance側API拡張が必要なため、今回は見送った)。
- 駅ラベルの高さ(labelY)・停車順バッジをLabelOverlayでも再現する場合は、
  `computeStationHousePlacement`の結果をApp.tsxまで引き回す配線が要る。
- glbモデル納品後、`TRAIN_MODEL_REGISTRY`への登録と実物での見た目確認
  (陰影・tint・LOD1切り替え)が必要。
- 建設プレビューの地平レールケース(RailBlock実形状)をwgpu側でも再現したい
  場合は`buildCellTrackParts`(railGeometry.ts)を1セル分だけ呼び出す形になる
  (現状は意図的にボックスへ簡略化)。

## R4d 実装メモ(0.5.0-Alpha-1a)

### 到達点

three.js の**描画スタック**を全面退役した。r3f の `<Canvas>`・drei（OrbitControls /
OrthographicCamera / Html）・classic モード・rendererPreference はすべて削除し、
ゲーム画面は wgpu キャンバス1枚 + DOM オーバーレイ（ラベル）+ GUI だけになった。
`three` npm パッケージは `src/render/*.ts` の **CPU側ジオメトリ演算** としてのみ残る
（完全撤去は R4e）。`@react-three/fiber` / `@react-three/drei` は package.json から削除。

### 1. フレームループ(`src/render/frameLoop.ts`)

r3f の描画ループが暗黙に決めていた実行順を、優先度つきの購読バスとして明示した。

```
FRAME_ORDER = { simulation: 0, feed: 10, camera: 20, render: 30 }
```

- `FrameLoop.runFrame(dt)` が1フレーム分を同期実行する。`start()/stop()` が rAF を回す
  （App.tsx の useEffect で起動）
- `dt` は `maxDelta = 0.1` 秒でクランプする（タブ復帰直後の巨大 delta でシミュレーションが
  飛ばないように。旧 r3f には無かった保護）
- 購読中の unsubscribe / 例外に耐える（スナップショットを取って回し、例外は console.error して
  次の購読者へ進む）
- React 側は `src/hooks/useFrameLoop.ts`（useFrame の置き換え）で購読する。コールバックは ref
  経由で最新版を呼ぶので、購読順は初回マウント順で安定する

移行したもの: `SimulationDriver`（simulation）、`useMeshChunkFeeder` / `WebGpuTrains` /
`WebGpuBuildPreview` / `WebGpuTownMarkers`（feed）、可視チャンク追跡とズームクランプ（camera）、
`WebGpuRenderDriver`（render、旧 `WebGpuCameraSync`）。

**デバッグフック**: `__dbgStep(dt,n)` は sim を n 回進めたあと `frameLoop.runFrame(0)` を呼ぶ
（delta=0 なので simulation フェーズは何もせず、feed→camera→render だけが走る）。
非表示タブでの検証手順がそのまま通る。`__debugWorld` / `__dbgFrames` も維持。
廃止: `__dbgThree` / `__camera` / `__orbitControls` / `__sun`。
新設: `__webgpuCamera`（`{centreX, centreZ, zoom}` の読み書き可能なオブジェクト）。

### 2. カメラ所有権と入力(`src/render/cameraState.ts` / GameScene の入力レイヤー)

カメラの真実源は TS の `GameCameraState = {centreX, centreZ, zoom}`。`zoom` は
**CSSピクセル/ワールド単位**で、旧 `OrthographicCamera.zoom` と同義（初期値 40、
`minZoomForFullMap` の戻り値をそのまま下限に使える）。毎フレーム `toWebGpuCameraState` で
物理ピクセル基準の `WebGpuCameraState` に変換して wasm へ push する。

旧 OrbitControls の設定（`enableRotate={false}`、`mouseButtons={{LEFT: undefined,
MIDDLE: DOLLY, RIGHT: PAN}}`、`minZoom`、`maxZoom=100`）を素のハンドラで再現した:

| 操作 | 旧(OrbitControls) | 新(入力レイヤー div) |
| --- | --- | --- |
| パン | 右ドラッグ | `pointerdown(button===2)` → `panByScreenDelta`（setPointerCapture、contextmenu は preventDefault） |
| ドリー | 中ドラッグ | `pointerdown(button===1)` → 下方向で縮小（OrbitControls の `_handleMouseMoveDolly` と同じ向き） |
| ズーム | ホイール | 非パッシブな native `wheel` リスナ。`0.95^notches`（1イベント最大4ノッチにクランプ）。**画面中心ズーム**（OrbitControls の orthographic dolly は注視点を動かさないので UX 据え置き） |
| 回転 | 無効 | 実装しない |
| キーボード | 未使用（`listenToKeyEvents` 未呼び出し） | 無し（GameUI の ArrowUp/Down による建設レベル切替は無関係なので従来どおり） |

ズーム下限は `minZoomFor(halfExtent, cssW, cssH)`（= `minZoomForFullMap` に 0.001 の床）。
R3 で WebGPU モードだけ解禁していた全図ズームアウトが、唯一の下限になった。
DPR・リサイズは App の ResizeObserver が `viewportRef` を更新し、`WebGpuRenderDriver` が
バックバッファサイズを合わせる。ビューポートが縮んで minZoom が上がった場合は camera フェーズで
現在のズームをクランプし直す。

**可視チャンク追跡**（旧 `CameraChunkTracker`）は `picking.ts` の `chunkViewFromCamera` で
閉形式化した（ビューポート4隅を y=0 平面へ落とした外接矩形の中心と半径、`halfExtent` でクランプ）。
スロットルは旧実装と同じ 150ms 間隔で、カメラ状態の署名が変わったフレームだけ再計算する。

### 3. 閉形式ピッキング(`src/render/picking.ts`)

`projectToScreenPx` の逆関数。`sx = (rx-rz)·ppu·ISO_X`, `sy = (rx+rz)·ppu·ISO_Y - y·ppu·ISO_H`
を y 固定で解く。

- `screenPxToGround(camera, sx, sy, yWorld)` — 任意の水平面への逆投影
- `pickGroundCell` — y=0 での丸め。**建設・選択の既定**（旧・地面プレーンの `e.point` 相当）
- `pickTerrainCell(camera, sx, sy, field)` — 高さ候補 `TERRAIN_HEIGHT_MAX..1` を上から走査し、
  「その高さの面へ落としたセルの実標高がその高さと一致する」最初のセルを返す。
  旧 `TerrainBlocks` の pickable 上面レイキャストと同じ結果になる（丘の頂上をクリックしたら
  頂上のセルが選ばれる）。**地形編集モード(raise/lower)でのみ使う**
- `clientToScreenPx` / `visibleGroundBounds` / `chunkViewFromCamera`

**注意（挙動の据え置き）**: 建設・選択は旧実装と同じく y=0 平面ピッキングのまま。したがって
標高のあるセルでは「見た目より手前のセル」が選ばれる（旧 three.js の地面プレーンと同じ癖で、
`elevatedCellCandidateFromGroundClick` はこの癖を前提にした補正）。ここを terrain-aware に
変えると高架駅クリックの補正と二重にずれるため、R4d では意図的に変更していない。

### ハンドラ移送表(GameScene の地面プレーン + window ハンドラ → 入力レイヤー div)

| 旧 | 新 | 備考 |
| --- | --- | --- |
| 地面プレーン `onPointerMove` | `handlePointerMove` | `cellFromEvent`（地形編集時のみ terrain-aware）で cursorPos 更新。同一セルなら state 更新をスキップ |
| 〃（列車ドラッグ昇格） | 同上の後半 | trainPress のセルから動いたら `setDraggingTrainId` |
| 地面プレーン `onPointerDown` | `handlePointerDown` | `button===2/1` はカメラ操作へ分岐。`button===0` のみゲーム入力。選択モードは `trainAtCell` で掴む、建設モードは `dragStartRef`+state |
| 地面プレーン `onPointerUp` | `handlePointerUp` | 列車ドロップ（`onRelocateTrain`）/ 建設コミット（`getConstrainedPath` / `rectCells` / 単セル、駅の軸ヒント）。`dragStartRef` を読む理由（単発クリックで state が未コミット）はコメントごと移設 |
| 地面プレーン `onPointerLeave` | `handlePointerLeave` | `handlePointerUp` + cursorPos クリア |
| 地面プレーン `onClick` | `handleClick` | shift+信号=撤去 / 駅クリック（運行表追加・駅選択）/ 車庫クリック=列車購入 / 高架駅候補 / 列車の画面空間ピック / 何も無ければ選択解除 |
| `DynamicTrain` の `onClick` | `handleClick` 内の `pickTrainAt` | R4c の `trainPicking.ts` をそのまま使う |
| `justDraggedRef`（DynamicTrain 側で消費） | `handleClick` の先頭で消費 | 元コメントの意図（ドラッグ直後の余計なクリックを1回無視）どおりに一本化 |
| `TerrainBlocks` の pickable 上面ハンドラ | `cellFromEvent` の `pickTerrainCell` 分岐 | メッシュを持たずに同じ結果を得る |
| OrbitControls の contextmenu 抑止 | `onContextMenu={preventDefault}` | 右ドラッグパンのため必須 |

### 4. 削除したファイル

`src/components/`: TerrainBlocks.tsx / TrackNetwork.tsx / Scenery.tsx / TownBlocks.tsx /
TownMarkers.tsx / DynamicTrain.tsx / TrainCar.tsx / StationLabel.tsx / RailBlock.tsx /
StationBlock.tsx / DepotBlock.tsx / SignalBlock.tsx
`src/render/`: groundTexture.ts（地面プレーン専用だった）
`src/ui/`: rendererPreference.ts（設定パネルのレンダラー選択ごと削除）
`src/render/palette.ts`: `MATERIALS` / `DIMMED_MATERIALS` / `materialsFor` / `bodyMaterial` /
`bodyMaterialDimmed` / `GEOMETRIES`（three.js マテリアル・共有ジオメトリ）を削除し、
色定数（`PALETTE`）・`angleFromVector`・`hash01` だけ残した。
`StationBlock.tsx` が持っていたホーム寸法定数（`PLATFORM_HEIGHT` 等）は
`src/render/stationGeometry.ts` へ移設し、そちらを一次情報源にした。

### 5. 新規・移管したもの

- `src/components/GameLabels.tsx` — 駅名・町名・列車ツールチップの DOM ラベル。R4c で App.tsx に
  あったものを GameScene 側へ移し、**R4c の既知ギャップ2件を解消**した:
  駅ラベルの Y は `computeStationHousePlacement` の `labelY`（高架駅で上屋にめり込まない値）を使う。
  選択中列車の運行表に含まれる駅には停車順バッジ（①②）を出す。アンカーも drei `<Html center>` と
  同じ中央合わせに戻した
- `src/components/WebGpuTownMarkers.tsx` — 遠景の町ドット。**R3 で wgpu へ移されていたという
  申し送りは誤りで、実際には three.js の `<TownMarkers>`（Points, sizeAttenuation:false）のまま
  残っていた**ので、ここで初めて wgpu へ移した。インスタンス API にスケール要素が無いため、
  プロトタイプメッシュ（八面体）自体をズームに応じた大きさで作り直す（比率 1.35 を超えたときだけ
  再登録）。極大マップの全図ズームアウトで 5074 町のドットが描けることを確認済み
- 建設グリッド（旧 `<gridHelper>`）— `WebGpuBuildPreview` の3つ目のチャンクとして、
  中心セル±48セルぶんの細板を半透明クラスで描く。中心は8セル単位にスナップして焼き直しを抑える
- WebGPU 非対応 / wasm 未ビルド / 初期化失敗の3種の**日本語案内画面**（App.tsx の
  `UnavailableScreen`）。three.js に依存しない素の DOM

### 6. 途中で見つけて直した既存バグ(R4d の本題外だが致命的)

- **メッシュチャンクの内容更新漏れ（R4b から潜在）**: `useMeshChunkFeeder` は
  「キーが可視集合に入ったか」でしか再構築を判断しておらず、**キーが変わらないまま内容だけが
  変わるチャンク**（レール網の `'surface'`、駅・車庫・信号・坑口・水上橋など）を初回の内容の
  まま放置していた。R4b/R4c の検証がシナリオ読込直後（=キーが新規）ばかりだったため見逃されて
  いたもので、実際に線路を敷いても何も現れない。`buildChunk` の**関数同一性の変化**を
  「焼き込み入力が変わった」信号として使い、既存キーを stale 集合に入れて予算内で載せ替える
  方式に変更した（remove→再作成ではなく上書きなので、作り直し中にちらつかない）。
  併せて `WebGpuStations` がインラインのアロー関数を `buildChunk` に渡していたのを
  `useCallback` 化した（そのままだと毎レンダー全再構築になる）
- **デバッグシナリオの地形不一致（R1 から潜在）**: wgpu は `(seed, halfExtent)` からしか地形を
  作れないのに、デバッグシナリオは `debugFieldOverride`（手組みの平坦 field など）を使う。
  classic が既定だった間は表面化しなかったが、wgpu 一本化で「TS は平地・描画はランダムな丘」に
  なり、線路も駅も丘に埋もれて**何も見えない**状態になっていた。`cornerDiffsFromField`
  （`sim/terrainOverlay.ts` に追加）で上書き field を全域のコーナー差分へ焼き直し、
  既存のオーバーレイ転送経路で wasm へ送るようにした。
  制約: `cellCornerHeights` を直接実装して4隅を不揃いにする擬似 field（山岳トンネルの尾根）は
  コーナー標高では表現できないため、そのシナリオの尾根は平坦に描かれる（R4e 以降の課題）

### 7. 既知の視覚差・簡略化(現状の一覧)

- 動的影が無い（R4a から。頂点色への焼き込み陰影のみ）
- 地下ビューの非選択レベルの**列車**は減光ではなく非表示（R4c から。インスタンス API に
  半透明クラスが無い。Rust 側 API 拡張が要るので R4d でも見送った）
- 駅のホームドアのガラスは全レベル alpha=0.55 固定（R4b から）
- 地平レールの建設プレビューは実レール形状ではなく半透明ボックス（R4c から、意図的）
- 列車ドラッグ中の向きは常に yaw=0（R4c から）
- 建設グリッドは中心±48セルまで（旧 gridHelper は地面プレーン全面）
- 建設・選択のピッキングは y=0 平面のまま（上記「注意（挙動の据え置き）」）

### ブラウザ検証(すべて WebGPU 実機、Chrome / Apple M4)

新規マップ（中 257×257）で: 右ドラッグのパン（`__webgpuCamera` の centre 変化を数値で確認）→
ホイールズーム（`maxZoom=100` と `minZoomForFullMap(128,1280,720)=3.4446` の両端でクランプ）→
地平線路のドラッグ敷設（直線 + 直角カーブ、`railMap` ダンプで `0,0..8,0 / 8,1..8,5` を確認、
スクリーンショットでカーブのベジェが繋がることを確認）→ 駅設置（ホーム・上屋・駅舎・ラベル）→
車庫設置 → 車庫クリックで列車購入 → 駅クリックで駅選択パネル → 信号設置（`signalDir:32`）→
**shift+クリックで信号撤去**（`railMap` から消えることを確認）→ 盛土の矩形ドラッグ
（(0,5)-(3,8) がちょうど1段上がることを確認）→ **丘の上（高さ1の面）を1回クリックして
(1,6) だけが2段になること**を確認（terrain-aware ピッキングが視覚どおりのセルを拾う。
y=0 平面ピックだと (0,5) が選ばれるケース）→ Lv1 の高架線路（桁・橋脚・端の坂）→
地下1の線路（地表が一括減光され、地下セグメントだけ通常輝度で上描き）→ 保存 → 読込
（線路・駅・車庫・高架・地形編集がすべて復元）。

デバッグシナリオ「坂・高架・往復列車」で: `__dbgStep(0.1,60)` の走行 → 列車が線路の上を
正しい向きで走ることをスクリーンショットで確認 → 列車のクリック選択（選択マーカー・黄色の
経路ドット・DOM ツールチップ・**駅ラベル上の停車順バッジ①②**）→ ドラッグでの置き直し
（掴んだ列車が持ち上がり、置き先に緑のゴーストが出る → 離すと `runtime.grid` が (-4,0) から
(2,0) へ移動、選択は維持）。

極大マップ（16385×16385、町 5074）で: 全図ズームアウト（zoom=0.05382 でクランプ、
`__webgpuStats` は drawCalls 9 / lod 5 / meshDrawCalls 17、`__dbgStep` 60回の平均 **1.71 ms/frame**）、
全町のドットが描画されることをスクリーンショットで確認。zoom=40 でのパン（120フレーム連続）も
破綻なし（`residentTiles` 25 / `tileGpuBytes` 6.6MB）。

ウィンドウリサイズ（1280×720 → 900×600）でバックバッファが 1800×1200 へ追従することを確認。
`public/renderer/` を退避した状態で「WebGPU レンダラーがビルドされていません +
`npm run build:renderer`」の案内画面が出ることを確認。

`npm run test` 899件 green / `npm run build` green / `npm run build:renderer` green。
`renderer/**` は未変更のため層A/層Bゲートは対象外。

### R4e への申し送り

- `three` の完全撤去（`src/render/*.ts` の BufferGeometry 生成・`mergeGeometry.ts`・
  `bakedMesh.ts` の THREE 依存を素の Float32Array ベースへ置き換える）
- 山岳トンネルのシナリオのように「コーナー標高では表現できない擬似 field」を wgpu へ渡す手段
  （wasm 側に生の高さグリッドを流し込む API か、シナリオ側を fieldFromMaps へ寄せるか）
- 地下ビューの非選択レベルの列車を半透明で描くためのインスタンス API 3クラス化（Rust 側）
- 建設・選択のピッキングを terrain-aware にするなら、`elevatedCellCandidateFromGroundClick`
  の補正と同時に見直すこと

## R4e 実装メモ(0.5.0-Alpha-2a)

R4の最終フェーズ。`src/render/*.ts` のCPU側ジオメトリ演算から `three` npm パッケージへの
依存を完全に取り除いた(R4dで描画スタック自体は撤去済み、残っていたのはBufferGeometry生成用の
ライブラリとしての利用のみ)。

### 1. キット設計(`src/render/geom/`)

対象コード(bakedMesh.ts / mergeGeometry.ts / 各 `*Geometry.ts`)の実際の使い方を先に棚卸しした
ところ、three.js のジオメトリから最終的に読まれる属性は **`position` だけ**だと判明した
(`bakedMesh.ts` の `bakeFlatShaded` が三角形ごとに自前で面法線を計算してフラットシェーディング
用の頂点色を焼き込むため、`normal`/`uv` は元から未使用)。この事実を前提に、キットは
position(と互換性のためだけのindex)のみを保持する最小クラスにした:

- `geom.ts` — `BufferGeometry`(position配列+任意のindex、`translate`/`rotateX,Y,Z`/
  `toNonIndexed`/`getAttribute`/`setAttribute`/`computeBoundingBox`/`dispose`(no-op)を持つ)、
  `BufferAttribute`/`Float32BufferAttribute`
- `primitives.ts` — `BoxGeometry`/`CylinderGeometry`/`ConeGeometry`(Cylinderのradius top=0特殊形)/
  `CircleGeometry`/`IcosahedronGeometry`/`OctahedronGeometry`。すべて **非indexedの三角形スープ**
  として直接生成する(flat shadingでは共有頂点に意味が無く、indexed→非index展開と直接生成が
  数学的に同じ結果になるため、常に非indexedにして変換コストそのものを無くした)。多面体系は
  three.js と同じ頂点/面テーブル(黄金比の正20面体、軸正8面体)を使い、detail>=1はエッジ中点を
  単位球へ再投影する再帰分割で対応(three.jsの重心分割アルゴリズムとdetail=1では一致する)
- `shape.ts` — `Shape`(moveTo/lineTo/closePathで点列を積むだけ)、`ExtrudeGeometry`(下記)
- `index.ts` — `import * as THREE from 'three'` を `import * as THREE from './geom'` へ
  置き換えるだけで済むよう、同じ名前をすべて再エクスポート。呼び出し側の `THREE.BoxGeometry(...)`
  等のコードは一切変更していない(型注釈の `THREE.BufferGeometry` もそのまま通る)

各ビルダーは頂点数・AABB・「全三角形の法線が形状の中心/重心から見て外向き」をテストで固定した
(`geom.test.ts`/`primitives.test.ts`/`shape.test.ts`、TDD)。box/cylinder/cone/circleは
手計算した頂点順の外積で外向きになることを事前検証してから実装し、extrudeは巻き順を
入力輪郭の向きに依存させず「各三角形の法線を実測し、期待方向でなければ頂点順を入れ替える」
頑健な実装にした(輪郭がCW/CCWどちらで渡されても正しい陰影になる)。

### 2. earcut採用

`tunnelPortalMeshGeometry.ts` の坑口ヘッドウォール/暗がりは `THREE.Shape`+`ExtrudeGeometry`
(bevel無効)で生成していた。対象の輪郭(`tunnelPortalGeometry.ts` の `buildHeadwallOutline`/
`buildArchOutline`)はいずれも**穴を持たない単一の閉じた折れ線**(アーチ開口は輪郭自体への
切り欠きとして織り込まれている)なので、three.jsが内部で使っているのと同じ `earcut`
(穴なしの単純多角形の三角形分割)をそのまま追加依存にした。バージョン3.2.3、型定義を同梱、
ESM。前面(z=0)・背面(z=depth)のキャップをearcutで三角形分割し、側面は輪郭の各辺を
矩形2枚として押し出す(caps/sidesとも法線を実測して外向きに補正する前述の頑健な方式)。

### 3. 移植したファイル

`import * as THREE from 'three'` → `import * as THREE from './geom'`(または
`'../render/geom'`)への置き換えのみで済んだファイル: `bakedMesh.ts` / `depotGeometry.ts` /
`railGeometry.ts`(型注釈のみ) / `sceneryGeometry.ts` / `signalGeometry.ts` /
`stationGeometry.ts` / `townGeometry.ts` / `trainMeshBuilder.ts` /
`tunnelPortalMeshGeometry.ts` / `waterBridgeGeometry.ts` / `components/WebGpuBuildPreview.tsx` /
`components/WebGpuTownMarkers.tsx`。

手を入れたファイル:

- `mergeGeometry.ts` — 「position以外の属性を保持しない」設計に合わせ、three.js版が
  やっていた「属性セットの和集合をゼロ埋めで揃えてから `mergeGeometries` へ渡す」処理を
  全面撤去。非indexed化した各ジオメトリの `position` 配列を単純に連結するだけになった
- `trackGeometry.ts` — 坂(ramp)のくさびジオメトリ(`makeCurvedWedgeGeometry`)が持っていた
  `uv` 属性と `computeVertexNormals()` 呼び出しを削除(前述のとおり最終的に未使用だった)
- `bakedMesh.test.ts` / `mergeGeometry.test.ts` / `stationGeometry.test.ts` — three.js製の
  ジオメトリをテスト用フィクスチャとして使っていた箇所をキット製に置き換え。
  `stationGeometry.test.ts` の `THREE.Vector3().getCenter()` はAABBの中心を手計算する形に
  書き換えた
- `webgpuCamera.test.ts` — `THREE.OrthographicCamera.lookAt`+`Vector3.project` を
  「投影の正しさを検証するオラクル」として使っていた箇所を、同じ行列演算(Matrix4.lookAt +
  対称正射影)を素のベクトル計算で再現したものに置き換えた。`render/webgpuCamera.ts`
  冒頭のコメントが既に基底ベクトル(Z_cam=(1,1,1)/√3等)を導出済みだったので、その式が
  素のベクトル演算と一致することを確認しながら実装した

### 4. 撤去

`package.json` から `three` と `@types/three` を削除(`npm uninstall three @types/three`)。
`grep -rl "from 'three'" src/` が0件になったことを確認。`vitest.config.ts` 等の設定ファイルは
元々threeへの直接依存が無かった。

### 5. バンドルサイズ

本番ビルド(`npm run build`、`tsc -b && vite build`)の出力を、R4d末尾コミット(8e11127、
`three`込み)との一時worktreeビルドで比較した:

| | three込み(R4d末) | three撤去後(R4e) | 差分 |
| --- | --- | --- | --- |
| JS(raw) | 486.65 kB | 383.08 kB | -103.57 kB(-21.3%) |
| JS(gzip) | 157.86 kB | 128.92 kB | -28.94 kB(-18.3%) |

### 6. ブラウザ検証(WebGPU実機、Chrome、dev port 5175)

デバッグシナリオ「坂・高架・往復列車」(地平線路・駅ホーム/上屋/柱/駅舎・坂・高架桁+橋脚・
列車、`__dbgStep`で走行)、「山岳トンネル」(坑口=ExtrudeGeometry+earcutの実地確認、
ヘッドウォール/笠石/暗がり/中実ボディの4パーツとも黒面・法線反転なし)、新規マップ生成時の
町(box+coneの住宅、高層/中層のパラペット付きビル、道路スラブ+縁石)を目視確認。
手動で線路(直線+坂の自動接続)・信号(mast/head/wings/marker、CylinderGeometry+BoxGeometry+
CircleGeometry)・車庫(BoxGeometry群、屋根の傾斜込み)を建設し、いずれも陰影が正しく
(面ごとに明暗が付き、黒面や裏返りが無い)描画されることを確認した。地下ビューへの切替で
地表全体が一括減光されることも確認(wgpu側のdim uniformは変更していないため回帰なし)。
`__debugWorld.railMap`/`stations` のダンプで建設結果の座標・接続を照合し、目視確認の裏取りとした。

セッション中、`npm uninstall three` 直後のVite依存事前バンドル再構築のタイミングで
一時的に「WebGPUレンダラーが未ビルドです」の404+Reactフックエラーが発生したが、
これはR4dの実装メモに記録済みのHMRアーティファクト(依存関係変更直後のVite再最適化に
起因する開発時限定の現象)と同種で、ページの再読み込み(新規セッション)後は再発しなかった。

### 7. ゲート結果

`npm run test`: 930件 green(キットのテスト31件を含む)。`npm run build`: green。
`npm run build:renderer`: green(`renderer/**` は今回無変更)。

**層B(Mac / Apple M4 / Metal、3回計測、`renderer/renderer_wgpu` の `layer_b_bench` release
バイナリ)**: T1〜T7 のstrict閾値すべて3回とも全pass。
run1: T1 median 0.605ms/p99 2.693ms、T4 median 1.983ms/p99 5.320ms、T3/T5 hitch 0/10260。
run2: T1 median 0.603ms/p99 2.844ms、T4 median 1.920ms/p99 5.191ms、T3/T5 hitch 0/10260。
run3: T1 median 0.620ms/p99 2.758ms、T4 median 1.946ms/p99 4.850ms、T3/T5 hitch 0/10260。
T6(firstFrame)は3回とも10ms未満(閾値300ms)。T8はプロトタイプスコープ外(既定どおりnull)。
`renderer/**` は本フェーズで無変更のため回帰は想定どおり無し。

**層A(VM / llvmpipe / Vulkan、`node renderer/bench/run-layer-a.mjs --browser-exact
--check-ts-migration`)**: build(workspaceTests/nativeBins/productionTsVsRust1M/wasmPack/vite)
すべて true。判定対象のゲートは全pass(`pass:null` は層B専用ゲート)。
A1 median 0.000099ms・p99 0.000173ms、A2 0.000835ms/tile、A3 mismatches 0・CPU diff median
0.010272ms、A5/T10 heap 1,245,184B(上限96MiB)、A6/T15 wasm gzip 86,816B(上限1MiB)、A7 hitch 0、
A8 決定性true、T4/T11 drawCalls 9(上限24)、T6 firstFrame 63.29ms、T14 5シード×1000万点
mismatch 0、A4 browser-exact(BrowserWebGPU読み戻し・`src/sim/terrainField.ts`とRustの
100万点バイト一致含む)mismatch 0、cameraReplay 3回とも ok(score 122/245/68)。
`renderer/**` は本フェーズで無変更のため、R4d以前と同じ数値帯であることを確認できた
(回帰なし)。

### 8. 既知の非互換・見た目の差

- 無し(見た目・寸法・配置は意図的にthree.js版と同一になるよう作った。差分は「表現手段が
  変わっただけ」に留める設計方針を貫いた)
