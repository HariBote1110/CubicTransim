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
- **層A(VM / llvmpipe)**: `node bench/run-layer-a.mjs --browser-exact --check-ts-migration`
  を実施(結果は下記の実行ログ参照)

### 次フェーズ(R4b)への申し送り

- レール網・駅・車庫・信号は同じ `useMeshChunkFeeder` に載せられる。地下レイヤーは
  `MESH_LAYER_CLASS.underground`、ホーム扉ガラス・建設プレビューは `translucent`
- 町名ラベル・駅ラベルはまだ drei `<Html>` のまま(R4c で DOM オーバーレイへ)
