# CubicTransim

OpenTTD・A列車で行こう系を目指すインフラ整備ゲームのプロトタイプ。React + TypeScript + Vite。
描画は Rust + wgpu(WebGPU)の自前レンダラー1本（R4d で three.js / react-three-fiber / drei は全面退役）。

## コマンド

- `npm run dev` — 開発サーバ (port 5173)
- `npm run test` — Vitest（純粋ロジックのテスト）
- `npm run build` — tsc -b && vite build（型検査込み。コミット前に必ず通すこと）
- `npm run build:renderer` — Rust製WebGPUレンダラー（`renderer/`）を wasm-pack --release でビルドし `public/renderer/` へ出力する。**これを実行しないとゲームは起動しない**（three.js のフォールバックは廃止した。成果物はコミットしないので、clone 直後や `renderer/` を触ったあとは必ず走らせること。未ビルド時は `npm run build:renderer` を促す案内画面が出る）

## アーキテクチャ

- `src/sim/` — **純粋なシミュレーション層**（React/THREE 非依存）。ゲームロジックは必ずここに書き、Vitest でテストする
  - `simulation.ts` — `stepWorld(world, dt)` が全列車を dt 秒進める。走行状態は `TrainRuntime`（ミュータブル）
  - `pathfinding.ts` — BFS 経路探索
  - `persistence.ts` — セーブデータの serialise/deserialise
  - `physics.ts` — 加速モデルとジャーク制限つきの制動曲線（`permittedSpeedKmh` / `rampDecel` / `brakingDistanceM`）。速度制御と予約延長判定は必ず同じ制動距離の式を使うこと
  - `buildPreview.ts` — 建設のコスト・可否判定。UIに条件を書き写さず、construction.ts の apply系に問い合わせて判定する
  - `trackPath.ts` — 線路の中心線（セルを通る2次ベジェ）。`renderPos` と `carPositions` の走行線はこれに載せる。描画側 `render/trackGeometry.ts` と同じ定義なので、レールと列車がずれない
  - `groups.ts` — 運用グループ（共有運行表＋発車間隔による等間隔化）
  - `townTiles.ts` — タイルベースの町（家・道路）。町id・人口・地形・線路網から決定的に再生成（セーブ不要）。地平の線路は家タイル不可・道路タイルは踏切として可、高架の桁は上空通過可（坂は不可）、駅/車庫/信号は町タイル不可。索引は useGameLogic の townTileIndex（useMemo）を全経路で共有する
  - `terrainField.ts` — 地形の一次データ。`createTerrainField(seed, halfExtent, profile)` がコーナー格子（頂点標高）の純関数 `cornerHeightAt`/`cellCornerHeights`/`cellHeightAt`/`terrainTypeAt` を返す。全セル実体化せず、ノイズのオクターブ振幅・波長そのものから1-Lipschitz（隣接コーナー段差1以下）を構成保証するため正規化パスが無く、16Kマップでもチャンク非依存にO(1)/セルで計算できる。第3引数の地形プロファイル(平坦/標準/山がち)は標高しきい値テーブルだけを差し替える(既定=標準=歴史的既定とバイト一致。progress/terrain-profiles.md)
  - `terrainOverlay.ts` — 盛土/切土の疎な編集オーバーレイ（チャンク単位の差分Map）と `applyCornerEdit`（矩形選択を±1段、方向つきBFS伝播で段差1以下を回復、同一参照no-op）。旧terrainEdit.ts（全域Mapクローン方式）を置き換えた。`buildEditBlockers` がrail/町タイル/水域/範囲外のブロック条件を1つの述語にまとめる共有ヘルパー
- `src/hooks/useGameLogic.ts` — React state（railMap/stations/trains）と `worldRef: SimWorld` の同期、建設・購入ロジック
- `src/components/` — wgpu への供給とDOM。React は「何を描くか」を決めるだけで、描画は wgpu が行う
  - `GameScene.tsx` — 入力レイヤー（透明な div）のポインタ/ホイール処理、建設・選択の状態、フィーダ群のマウント。three.js のシーングラフは無い
  - `WebGpuTerrainLayer.tsx` — wgpu キャンバス本体と `WebGpuRenderDriver`（毎フレーム `setCamera` → `render()`）
  - `WebGpu*.tsx` + `useMeshChunkFeeder.ts` — TS で焼いたジオメトリを「メッシュチャンク」として wgpu へ差分供給する。**`buildChunk` の関数同一性が「内容が変わったか」の判定に使われる**ので、インラインのアロー関数を渡してはいけない（毎フレーム全再構築になる）
  - `SimulationDriver.tsx` — 共有 rAF ループの simulation フェーズで `stepWorld` を呼ぶ
- `src/render/` — 描画専用の純粋ロジック。sim層からは参照しない
  - `frameLoop.ts` — 唯一の requestAnimationFrame オーケストレータ。1フレームは simulation → feed → camera → render の順（`FRAME_ORDER`）。`runFrame(dt)` で同期実行もできる（`__dbgStep` が使う）
  - `cameraState.ts` — カメラの真実源 `{centreX, centreZ, zoom}`（zoom は CSSピクセル/ワールド単位）。パン・ズームは純関数
  - `picking.ts` — `projectToScreenPx` の閉形式逆関数。`pickGroundCell`（y=0平面、建設・選択の既定）/ `pickTerrainCell`（高さ候補を上から走査、地形編集モード用）/ `chunkViewFromCamera`（可視チャンク追跡）
  - `bakedMesh.ts` — 面単位ランバート陰影を頂点色へ焼き込む（wgpu にライトは無い）
- `src/ui/theme.ts` — GUIのデザイントークン。UIの配色・角丸・余白・ボタンはここを経由すること（インラインstyleの直書きを増やさない）
- 設計判断・既知バグは `progress/INDEX.md` から辿ること

## ブラウザでの動作検証手順（エージェント向け）

Browser ツール（`mcp__Claude_Browser__*`）で検証する。`preview_start` で name "dev" のサーバを起動（.claude/launch.json 設定済み）。

**前提**: `npm run build:renderer` を済ませておくこと（未ビルドだと案内画面しか出ない）。WebGPU 必須なので Chrome/Edge/Electron で開く。

**重要な注意点:**

1. **非表示タブでは requestAnimationFrame が止まり、シミュレーションも描画も進まない**。列車の走行検証は画面を眺めるのではなく、`javascript_tool` で手動 tick する:
   - `window.__dbgStep(dt, n)` — stepWorld を dt 秒 × n 回進めたあと、フィーダ・カメラ・描画を1フレーム分だけ走らせる（SimulationDriver が公開）
   - `window.__debugWorld` — SimWorld（railMap/stations/trains/runtimes）を直接読める
   - `window.__dbgFrames` — 共有 rAF ループが回したフレーム数
   - 例: `window.__dbgStep(0.1, 100)` で10秒進め、`__debugWorld.runtimes` の grid/speedKmh/debugStatus を確認
2. **メッシュチャンクは1フレームに6件までしか載せ替わらない**（`MAX_CHUNK_UPLOADS_PER_FRAME`）。新規ゲーム・セーブ読込・デバッグシナリオ読込の直後にスクリーンショットを撮ると「地形だけで線路も木も無い」絵になる。`for(let i=0;i<150;i++) window.__dbgStep(0,0)` のように**空 tick を数十〜百回回してから**撮ること
3. **同期 JS ループ内では arrive イベント→React の scheduleIndex 更新が反映されない**（バッチング）。複数駅の走行検証は `__dbgStep` を複数回の `javascript_exec` に分けて呼ぶこと
4. **クリック座標は screenshot 空間**。screenshot の出力に `Screenshot size: 800x450` のように書かれた値が click/hover の座標系で、画像そのものは 1600x900 で返る。実 CSS 座標との比は `document.querySelector('canvas').getBoundingClientRect()` と突き合わせて毎回確認する（1280x720 のビューポートなら CSS 座標 ÷1.6 が click 座標）
5. **hover してから click する必要は無くなった**（R4d）。ポインタハンドラはイベントの clientX/clientY からその場でセルを求めるので、単発 click / left_click_drag だけで正しいセルに建設できる
6. **カメラ操作**: 右ドラッグ=パン、中ドラッグ=ドリー、ホイール=画面中心ズーム（カーソル位置へは寄らない）。`computer` ツールは右ドラッグを出せないので、`javascript_tool` から `PointerEvent('pointerdown', {button:2, buttons:2, pointerId:1, ...})` を入力レイヤー（`[data-testid="game-input-layer"]`）へ dispatch する
7. **カメラ状態は `window.__webgpuCamera` で読み書きできる**（`{centreX, centreZ, zoom}` のミュータブルなオブジェクト。書き込むと次フレームの描画に反映される）。旧 `__camera` / `__orbitControls` / `__dbgThree` / `__sun` は廃止した。描画統計は `window.__webgpuStats`、レンダラー本体は `window.__webgpuLayer`
8. 建設結果の確認は screenshot より `__debugWorld.railMap` のダンプが確実
9. カメラ初期状態（centre=原点・zoom=40）では画面中央が原点。世界 +x は画面右下方向。CSS ピクセルでは 1セル = `(+zoom/√2, +zoom/√6)` = zoom 40 なら (+28.3, +16.3)。画面横方向のドラッグは斜め線路になるので注意
10. HMR（コード編集の反映）後に "Rendered more hooks than during the previous render" が出ることがあるが、これは開発中のアーティファクト。**必ずページを再読み込みしてから**検証すること（React がクラッシュしたままだとリサイズなどが効かず誤診断のもとになる）

## 描画の注意点

- ジオメトリ生成は `render/geom/`（three.js を代替する自前の最小キット。R4e で `three`
  パッケージそのものを撤去した）。`BoxGeometry`/`CylinderGeometry`/`ConeGeometry`/
  `CircleGeometry`/`IcosahedronGeometry`/`OctahedronGeometry`/`Shape`+`ExtrudeGeometry`
  はいずれも **非indexed の三角形スープ**を直接生成する（`position` 属性しか保持しない。
  `bakedMesh.ts` が三角形ごとに面法線を計算し直すため normal/uv は元から不要）。マージは
  `render/mergeGeometry.ts` の `mergeAndDispose()`（非indexed化してから `position` を連結する
  だけ）。ExtrudeGeometry の三角形分割には `earcut`（唯一の外部依存）を使い、輪郭の巻き順に
  関わらず各三角形の法線を実測して外向きに補正する
- ライトは無い。陰影は `render/bakedMesh.ts` が頂点色へ焼き込む（光方向は旧 SunLight と同じ
  `(-30, 34, 14)` の正規化）。動的影も無い

## 規約

- ゲームロジックの変更は TDD（Red→Green→Refactor）。テストとコミットをこまめに
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 識別子・コード内英語は British English（colour, serialise 等）
- ユーザー向け文書・progress/ は日本語
