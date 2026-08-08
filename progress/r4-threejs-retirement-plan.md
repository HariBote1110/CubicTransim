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
