# 透視投影カメラ(乗客視点)実装メモ — D1/D2/D3スパイク

状態: **D1・D2・D3スパイクとも完了**(`feature/perspective-camera` ブランチ、`main`未マージ)。
`progress/play-modes-plan.md` の「遠い将来の夢(絵空事メモ)」節にある乗客視点構想を、
案B(クォータービューとは完全に別経路の透視投影パス)として最小実装した。

## 背景

`play-modes-plan.md` の「遠い将来の夢」節に、以下の記述がある(2026-08-11時点):

> **乗客視点**: 列車に「乗って」車窓を眺めるカメラ。現行カメラは俯瞰直交投影
> (cameraState.ts)なので、透視投影カメラのモードを wgpu レンダラーに足す必要がある。
> `renderPos`/`trackPath.ts` の走行線上にカメラを置くだけなので sim 層は無改造で済む見込み

本タスクはこの「透視投影カメラのモード」の部分だけを先取りするスパイクで、実際の
乗車UI(D2、`renderPos`上にカメラを置いて追従させる仕組み)はスコープ外。

## API(wasm-bindgen)

- `setCameraPerspective(eyeX, eyeY, eyeZ, lookX, lookY, lookZ, fovYRadians)`:
  透視カメラの視点・注視点・垂直画角を更新する。クォータービューの `setCamera`
  (center_x/center_z/pixels_per_cell 等)とは完全に独立したフィールド
  (`persp_eye`/`persp_look`/`persp_fov_y`)に書く。
- `setCameraMode(mode: 'quarter' | 'perspective')`: `render()` がどちらの経路を
  通るかを切り替える。既定は `'quarter'`。未知の文字列は `'quarter'` に丸める。
- どちらも `src/render/webgpuLayer.ts` の `WebGpuTerrainLayerController` に
  `setCameraPerspective(eye, look, fovY)` / `setCameraMode(mode)` として薄くラップして
  ある(旧い wasm 成果物との互換のため optional chaining で呼ぶ)。

## パイプライン構造

- `renderer/renderer_wgpu/src/lib.rs` の `perspective` モジュール(target非依存、
  ネイティブ `cargo test` で検証):right-handed lookAt + 透視投影行列(深度レンジ
  [0,1]、reversed-Zは**使わない**——wgpu 側の `LessEqual` 比較・`Clear(1.0)` を
  クォータービューとそのまま共有できる最も単純な選択)。`aabb_visible_persp` が
  view_proj 行列でAABB8頂点をクリップ空間へ写し、6平面すべてに対して「8頂点が
  全て外側」なら不可視、というフラスタムカリング(保守的判定、偽陽性は許容)。
- `mesh_pipeline::create_perspective_all` が `mesh_draw_persp.wgsl` /
  `mesh_instanced_persp.wgsl` 用のパイプラインを作る。**camera_bgl/class_bgl
  (バインドグループレイアウト)はクォータービューと共有**——どちらも「uniform
  1本、サイズ制約なし」の汎用レイアウトなので、中身が iso 用32バイト構造体でも
  透視用96バイト構造体でも同じレイアウトオブジェクトへ束ねられる。専用なのは
  シェーダモジュールと、透視カメラの中身を持つ `persp_camera_buffer`
  (96バイト: view_proj mat4×64 + eye.xyz+fog_end×16 + sky.rgb+dim×16)だけ。
- `CanvasRenderer::render()` は `self.mode` で分岐する:
  - `Quarter`(既定): 既存コードをそのまま実行(地形 indirect draw → メッシュ
    チャンク → インスタンス → 半透明、の順)。**この分岐に入る限りバイト単位で
    無改造**——タイル選択・camera_bytes書き込み・パスの構造・呼び出し順序を
    一切変えていない。
  - `Perspective`: iso 用の地形 indirect draw を**完全にスキップ**する。地形は
    TS 側が通常のメッシュチャンク(Surfaceクラス)として送ってくる前提。
    `persp_mesh_pipelines`/`persp_instanced_pipelines` で Surface→Surfaceインスタンス
    →(eye.y<0 のときのみ)Underground→Undergroundインスタンス→Translucent の順に描く。
    UndergroundGhost(地上ビューでの地下ゴースト)はクォータービュー固有の演出
    なので透視パスでは描かない(スコープ外、D2以降で必要になれば検討)。
- クリアカラー: `eye.y >= 0` なら空色 `(0.53, 0.75, 0.93)`、`eye.y < 0` なら
  ほぼ黒 `(0.02, 0.02, 0.03)`。地下ビュー用の演出は今回はクリアカラー切り替え
  だけで、地下メッシュの深度比較(Always)自体はクォータービューと同じ
  `depth_blend_state_for` をそのまま流用している。
- フォグ: フラグメントシェーダで `dist = length(world_pos - eye)`、
  `fog_t = clamp(dist / fog_end, 0, 1)` を計算し `mix(shaded, sky, fog_t)`。
  `fog_end` = `PERSP_DRAW_RADIUS`(定数 300 ワールド単位)= 遠クリップ面と同じ値
  にしてあるので、描画半径の外周カットオフは霧の中に隠れる(要求どおり)。
  微分命令(dpdx/dpdy)は使っていない(WGSLブラウザ検証器の既知の罠を踏まないため)。

## 地形メッシュの作り方

`src/render/perspectiveTerrain.ts` の `buildPerspectiveTerrainMesh(field, centreX,
centreZ, radiusCells)` が、視点中心±radiusCellsの矩形を `field.cellCornerHeights`
で素朴に三角形化し(1セル=2三角形、`bakeFlatShaded` で面法線から陰影を焼き込む)、
既存の `uploadMeshChunk`(id=`0xA000_0001`、他のジオラマ物と衝突しない専用の名前空間、
`meshChunkRegistry.ts` の0x1000_0000刻みの帯とは別に確保)へ載せるだけ。**iso indirect
draw のタイル機構やコンピュートシェーダには一切触れていない**(タスク指示どおり)。
`WebGpuRenderDriver`(`src/components/WebGpuTerrainLayer.tsx`)が、視点セルが
`PERSPECTIVE_TERRAIN_REBAKE_THRESHOLD`(8セル)以上動いたときだけ焼き直す。

## デバッグフック・フレームループ配線

- `WebGpuRenderDriver` の mount 時に `window.__perspectiveDebug = { enter(eye, look,
  fovY?), exit() }` を公開する。実際の乗車UI(D2)はこのフックを置き換える想定。
- `perspectiveDebugState`(モジュール単位のミュータブルフラグ、`active`/`eye`/
  `look`/`fovYRadians`/`lastTerrainCentre`)を `WebGpuTerrainLayer.tsx` に持たせた。
  `active===true` の間、`WebGpuRenderDriver` の `useFrameLoop` コールバックは
  `setCameraMode('perspective')` + `setCameraPerspective(...)` を毎フレーム送り、
  クォータービューの `setDim` 以外の状態同期(`stateRef` 書き込みなど)は行わない。
  `active===false` に戻ると `setCameraMode('quarter')` を送り、従来どおり
  `toWebGpuCameraState`/`syncAndRender` の経路(`setCamera`含む)を通す。

### 見つけて直したバグ: 透視地形チャンクの残留

実装直後のブラウザ実機検証で、`enter()`→`exit()` 後のクォータービューに
チェッカー状のノイズが地形へ重なって見える不具合を発見した。原因は
`exit()` が `perspectiveDebugState.active` を戻すだけで、`uploadMeshChunk` で
載せた透視パス専用の地形メッシュチャンク(id `0xA000_0001`、layerClass=Surface)を
外していなかったこと——クォータービューの `draw_class(Surface)` は「id」を見ずに
「layerClass」だけで全チャンクを走査するため、透視用の(iso投影とはズレた位置の)
地形メッシュがそのままクォータービューにも二重描画されていた。
`exit()` に `layerRef.current?.removeMeshChunk(PERSPECTIVE_TERRAIN_CHUNK_ID)` を
追加して解消(ブラウザ実機で修正前後のスクリーンショット比較済み)。

## 検証結果

- `cargo test`(renderer_wgpu、ネイティブ):20件 green(`perspective` モジュールの
  4件を含む: lookAt/透視行列の前方投影・背後カリング・視野外カリング)。
- `npm run build:renderer` → `npm run build`(tsc+vite)→ `npm run test`(1068件)
  いずれも green。
- ブラウザ実機(小マップ、ライトモード): `window.__perspectiveDebug.enter([0,1.6,0],
  [10,1.2,5])` で地形が遠方へ収束する透視パースがかかった絵になること、
  `__webgpuStats.meshChunks` が19→20(地形チャンク追加)・`meshDrawCalls` が
  4→9(地形+町+木の描画が乗った)に増えることを確認。木・町並みのメッシュが
  正しく透視投影で描かれることをスクリーンショットで確認。`exit()` 後は
  `meshChunks` が19に戻り、クォータービューがバグ修正後は差分なしに戻ることを
  確認(修正前は上記のチェッカーノイズが残った)。

## デフォルト実行時のCLAUDE.md記載どおりの罠

- devサーバは `.claude/launch.json` の "dev"(port 5175)がこのタスク実施時点で
  **別セッションが使用中**だったため、本検証では一時的に `npm run dev -- --port
  5199` を直接起動して検証した(`preview_start` は他セッションの5175を再利用して
  しまい、このワークツリーの変更を反映しないビルドを見せていた——ワークツリー越しの
  エージェント作業で今後も起こりうる罠として記録しておく)。

## 残る follow-up(マージ前に検討すること)

- **性能ゲート未実施**: タスク指示どおり、層A(VM)/層B(Mac)の性能ゲートは
  本スパイクでは回していない。マージ前に回すこと(TODO)。
- クォータービューのカメラ供給(`setCamera`)自体は透視モード中も
  `syncAndRender` 経由で毎フレーム呼ばれ続けている(Rust側は `mode` で無視する
  だけ)。「供給を止める」を文字通り実装するなら `syncAndRender` をカメラ計算と
  リサイズ処理とに分割する必要があるが、今回は実害が無い(モードゲートで
  無視されるだけ)ためスパイクの範囲では見送った。
- 透視パスの地形メッシュはオンデマンド生成のみで、チャンク分割・LODは無し
  (`radiusCells=48` の単一メッシュを丸ごと再構築する)。乗車UI(D2)で
  移動が常時発生するようになったら、チャンク化やヒステリシス付き再構築間隔の
  調整が要る。
- 地下ビュー用のUndergroundGhostクラスは透視パスでは描かない(スコープ外)。
- 列車内から見た運転台・車内モデルなどの演出は無し(D2以降)。
- Rust側 `perspective::aabb_visible_persp` は境界ケース(視錐台の角を斜めに
  横切るAABBを偽陽性判定する)がある保守的判定。オーバードローは許容範囲
  (メッシュチャンク数は少ない)と判断し、厳密な分離軸判定は導入していない。

## D2実装メモ(乗客視点UI・カメラ追従)

D1で作った透視パス(setCameraPerspective/setCameraMode)の上に、実際に列車を選んで
「乗る」UIとカメラ追従を実装した。`window.__perspectiveDebug`(D1のデバッグフック)は
そのまま残してあり、乗車(riderState)より優先度が低い(乗車中はriderStateが勝つ)。

### カメラ数学の再利用

`src/render/passengerView.ts` の `computeRiderCamera(world, trainId)` が全て:

- `sim/consist.ts` の `carPositions(rt, 1, 1.0, world.railMap, world.terrainField)` を
  呼び、先頭車(1両だけ)の位置(x/y/z)と進行方向(heading、単位ベクトル)を得る。
  **カーブそのものの再実装はしていない**——carPositionsが列車描画のために持つ
  「前後の台車位置(弧長±BOGIE_HALF_SPACING)から求めた向き」をそのまま使う。
  勾配・高架(OVERPASS_HEIGHT)・地下(負のlayer)の高さも、carPositions内部の
  `trackCentreHeight`(railMap/terrainFieldを渡したときだけ有効)がそのまま面倒を見る
  ので、列車の描画位置(WebGpuTrains.tsx)と乗客視点のy座標は完全に同じ式から来る。
- `eye = [head.x, head.y + PASSENGER_EYE_HEIGHT(1.6), head.z]`
- `look = eye + head.heading * PASSENGER_LOOK_AHEAD(9)`(headingをそのまま外挿する
  だけ。headingはcarPositionsの前後台車サンプリングで既に滑らかなので、外挿点も
  カーブ進入・脱出でカクつかない)
- 補間・平滑化は一切行わない(毎フレームその場の状態から組み立て直す)。折り返し・
  車庫への瞬間移動でも、次のフレームで新しい位置がそのまま出るだけなので前フレームを
  引きずらず自然にスナップする(ブラウザ実機で反転区間を確認、カメラが破綻せず
  向きだけ入れ替わることを確認した)。
- `computeRiderCamera`は純関数(sim/consist.tsのcarPositionsのみに依存)なので
  Vitestで直接テストできる(`passengerView.test.ts`)。TDD Red→Greenで実装した。

### 乗車状態の設計: 二重管理(モジュール単位フラグ + Reactステート)

D1の`perspectiveDebugState`と同じ設計判断を踏襲した:

- **真実源**: `riderState.trainId`(`passengerView.ts`のモジュール単位ミュータブル
  フラグ)。`WebGpuTerrainLayer.tsx`のWebGpuRenderDriver(フレームループのrenderフェーズ)
  と`GameScene.tsx`のチャンク可視範囲計算(フレームループのcameraフェーズ)が、
  Reactの再レンダリングを経由せず**毎フレーム直接読む**。列車は毎tick動くので、
  Reactステート経由(setState→再レンダリング)だと余計なコストとラグが乗る。
- **UI用の鏡写し**: `App.tsx`の`ridingTrainId`(Reactステート)。乗車/降車ボタンの
  ラベル・「降車」オーバーレイの表示切替・入力レイヤーのpointerEvents無効化など、
  **JSXが読む必要がある**部分だけがこちらを参照する。`handleBoardTrain`/
  `handleAlightTrain`が両方を同時に更新する。

### チャンク供給(D1で積み残していた課題への対応)

`picking.ts`の`chunkViewFromCamera`はクォータービューのカメラ(centreX/centreZ/zoom)
から可視範囲を求める、iso専用の関数。乗車中はそのカメラ供給自体を止めている
(D1の設計どおり)ので、`chunkViewFromCamera`をそのまま使うと可視チャンクが
乗車開始地点で固定されたままになり、列車が離れるとメッシュ(木・線路・駅など)が
供給されなくなる。

対処は「最小限の正しいアプローチ」(タスク指示どおり): `GameScene.tsx`の
既存のチャンク追跡ループ(`useFrameLoop(FRAME_ORDER.camera, ...)`、既存の
`ChunkView`仕組みをそのまま使う)に分岐を追加し、乗車中は
`{ targetCell: 視点セル(round(eye.x), round(eye.z)), viewRadiusCells:
PASSENGER_CHUNK_VIEW_RADIUS_CELLS(=48、D1の地形メッシュ半径と同じ) }`を
`setChunkView`へ渡すだけにした。既存の変更検知(targetCell/viewRadiusCellsが
同じならstate更新しない)・`CHUNK_VIEW_INTERVAL_MS`スロットルもそのまま効く。
`WebGpuScenery`/`WebGpuTrackNetwork`/`WebGpuStations`等のフィーダは`chunkView`
propを経由するだけなので、フィーダ側は無改造で済んだ。

### 地形メッシュの再構築タイミング

D1では「距離しきい値(8セル)を超えたら焼き直す」だけだったが、D2で「乗車開始
(=モード切替)の瞬間は距離に関わらず即座に焼き直したい」という要求が増えた
(乗車直後にD1時代の古い視点位置のメッシュが一瞬見えるのを避ける)。
`WebGpuRenderDriver`に`prevActiveKeyRef`(直前フレームの透視ソース、
`'ride:<id>' | 'debug' | null`)を追加し、これが変化したフレームは無条件で
`needsRebake = true`にした。同じ仕組みで、透視パスを抜けた瞬間
(降車・デバッグexit・乗車中の列車消失)にも地形メッシュチャンクを外す
(D1で見つけた「クォータービューに透視用メッシュが残留する」不具合の再発防止)。

### 入力ブロック・降車導線

- `GameScene.tsx`の入力レイヤー(`data-testid="game-input-layer"`)へ
  `pointerEvents: ridingTrainId ? 'none' : 'auto'`を付けるだけ(乗車は「眺めるだけ」の
  ビューモードなので、建設・選択などの入力を丸ごと無効化する。専用のブロッカーdivは
  作らず、入力レイヤー自体を無効化する最小実装にした)。
- 降車導線は3つ: (1) 列車インスペクタの「降車」ボタン(乗車中は「乗車」ボタンが
  差し替わる)、(2) 右上の「乗車中: 列車○○ [降車]」オーバーレイ(`GameScene.tsx`が
  `ridingTrainId`があるときだけ描画)、(3) Escキー(`GameUI.tsx`の既存の
  グローバルkeydownハンドラに`ridingTrainId`があれば降車を割り込ませた)。
- 乗車中の列車がワールドから消えた場合(到着後の回収など): フレームレベルでは
  `WebGpuRenderDriver`が`computeRiderCamera`がnullを返した時点で`riderState.trainId`
  を即座にクリアする(描画が破綻しないように)。React側の表示(`ridingTrainId`)は
  `GameUI.tsx`の既存の低頻度ポーリング(400ms、乗客数などと同じ間隔)に相乗りして
  追随させる。

### 地下

`eye.y < 0`のときD1のクリアカラー分岐(空色→ほぼ黒)がそのまま効くので、地下走行中は
自動的に暗い画面になる。トンネル壁のジオメトリはD1と同じくスコープ外(このplayモード
プロファイルではまだ十分な視覚情報にならないため、D2以降の課題として据え置く)。

### 検証結果

- Vitest: `passengerView.test.ts`(2件、Red→Green)を含め`npm run test`は1070件green。
- `npm run build`(tsc+vite)green。`cargo test`(renderer_wgpu)20件green
  (D2はRust側を変更していないため無変化)。
- ブラウザ実機(デバッグシナリオ「坂・高架・往復列車」`slopes-elevated-shuttle`):
  列車をクリックして選択→列車インスペクタの「乗車」ボタンをクリックして乗車、
  `__webgpuStats.meshChunks`が増加(透視地形メッシュが乗る)・
  `instancedDrawCalls`が透視パスのインスタンス描画に切り替わることを確認。
  地平→坂→高架(layer=1、renderPos.y上昇)→地平の一往復をスクリーンショットで確認
  (地形が透視パースで奥へ収束し、駅舎・線路・木が正しく描画された)。折り返し
  (進行方向反転)の前後でカメラが破綻せず向きだけ滑らかに入れ替わることを確認。
  右上の「降車」ボタンをクリックして退出し、クォータービューが乗車前と同一の見た目
  (残留メッシュ無し、パネルが元の「乗車」ボタン表示)に戻ることを確認した。

### 残るfollow-up(D2で新たに見つかった/据え置いたもの)

- DOMラベルオーバーレイ(`LabelOverlay.tsx`、駅名・列車速度ツールチップ)は
  `webGpuCameraStateRef`(iso投影)を経由しており、乗車中はこの状態を更新していない
  (D1の設計を踏襲)ため、ラベルは乗車開始時点の画面位置に取り残される。実害は無い
  (単に見た目が乗車前の位置のままなだけ)が、乗客視点の没入感を上げるなら
  「乗車中はラベルオーバーレイを隠す」か「透視投影でラベル位置を再計算する」かの
  どちらかの対応をD3以降で検討する。
- 乗車中のフォグ半径・地形メッシュ半径(48セル)は静的な定数のまま。高速で長い直線
  (特急など)では地平線側のフェードが早く見える可能性があり、将来チューニングの
  余地がある。
- 性能ゲート(層A/層B)は引き続き未実施(D1メモのTODOのまま)。

## D3実装メモ(運転台視点・HUD)

D2の乗客視点(客席)に、運転台視点(cab)とHUDオーバーレイを追加した。

### 運転台視点(mode='cab')

`computeRiderCamera(world, trainId, mode)` に第3引数 `mode: 'passenger' | 'cab'`
(既定'passenger')を追加しただけ。'cab'のときはeyeを進行方向(`head.heading`、
carPositionsの先頭車のもの)へ`CAB_FORWARD_OFFSET`(0.5、視覚調整値)だけ前へ出す。
高さ・注視点(look)の式はpassengerと共通。カーブの計算は増えていない
(headingの外挿という既存の仕組みをそのまま使うだけ)。`riderState`に`mode`
フィールドを追加し、D2と同じ「モジュール単位フラグ(真実源)+ Reactステート
(App.tsxのridingMode、UI再レンダリング用)」の二重管理を踏襲した。

列車インスペクタの乗車ボタンは「乗車(客席)」「運転台」の2ボタンに分けた
(`GameUI.tsx`のTrainInspector)。乗車中の側のボタンを押すと降車、もう片方を
押すと(降車せずに)そのモードへ切り替わる。Esc・右上オーバーレイの「降車」は
D2と同じくモード問わず効く。

### HUD(`src/components/CabHud.tsx` + `src/render/cabHud.ts`)

`computeCabHud(world, trainId)`(純関数、Vitestで検証済み)が以下を1回で計算する。
**sim層(simulation.ts)のロジック・テーブルは一切変更していない**(タスク仕様の
「no sim changes」を厳守。増やしたのは`distanceAlongRouteTo`/`distanceToStopPoint`
というstepTrainの内部ヘルパー2つを`export`しただけ——可視性の変更のみで、
呼び出し側の挙動もシグネチャも無改造)。

- **speedKmh**: `runtimes.get(trainId).speedKmh` をそのまま。
- **speedLimitKmh(制限速度)**: `simulation.ts`の`MAX_SPEED_KMH`をそのまま返す。
  このゲームには軌道等級(trackClasses)別の速度テーブルはまだ存在しない
  (`grep`で確認済み)ため、taskが想定していた「rail-weight cap」は該当なし——
  唯一存在する速度上限定数を再利用することで「テーブルを複製しない」方針を
  満たした。
- **次の停止点までの距離**: stepTrainの速度制御(simulation.ts 815〜836行)と
  **同じ分類**(`reservedEndIndex`が経路末尾まで届いていれば'station'扱いで
  `distanceToStopPoint(rt)`、そうでなければ次のsafe waiting pointまでの
  `distanceAlongRouteTo(rt, rt.reservedEndIndex)`)を、export した2関数を呼ぶだけで
  再現している。この分類自体(3行のif/else)はstepTrainのローカル変数の中にしか
  無く「no sim changes」の制約下ではsim側から公開しようが無いため、cabHud.ts側で
  同じ3行を再掲した(コメントで両者の対応を明記)。距離計算そのもの(弧長積分)は
  100%再利用で重複していない。
- **次信号の現示**: 経路(`rt.route`)を先頭から`NEXT_SIGNAL_LOOKAHEAD_CELLS`(20)
  セルだけ走査し、`signalDir`を持つ最初のセル(index=i)を探す。
  `rt.reservedEndIndex >= i` なら開通(green、その信号の先まで予約が届いている)、
  そうでなければ停止(red)。信号が見つからなければnull(HUDには「なし」を出す)。
  s1/s2/s3という信号方式の段階は`gameRules.ts`にフラグとしては存在するが、
  実装(PM1のdesign decision)として**どのモードでもコードは無分岐**——このゲームの
  信号・閉塞は「PBS予約+safe waiting point」という単一の仕組みで動いている
  (progress/signalling-plan.mdにS0=既定仕様として明記済み)。そのためHUDの
  信号現示も`rules.signalling`を見ずに、実際に置かれた信号セルと予約状態だけから
  求める(将来s1〜s3が実装されても、この仕組みの上に乗る限り無改造で動く見込み)。
- **デッドセクション予告**: 現在地から`DEAD_SECTION_LOOKAHEAD_CELLS`(10、タスク
  仕様どおり)セル先までの隣接セル対それぞれに`gameRules.ts`の
  `isDeadSectionBoundary`(既存の純関数、PM3で実装済み)を適用し、1つでもtrueなら
  警告チップを出す。

`CabHud.tsx`はこの`computeCabHud`を150ms間隔でポーリングしてDOM(`ui/theme.ts`の
`panel`/トークン経由)へ表示するだけの薄いコンポーネント。sim層への書き込みは無い。
`GameScene.tsx`が`ridingMode==='cab'`のときだけマウントする。

### DOMラベルの乗車中非表示

`GameLabels`(駅名・列車速度ツールチップ)は`hidden`propを既に持っていたので、
`hidden={farViewHidden || !!ridingTrainId}`を足すだけで済んだ(客席・運転台の
どちらでも隠れる)。D2メモに記載した「凍結されたisoカメラで投影しており位置が
合わない」問題への対処として、非表示にする方を選んだ(タスク指示どおり
「simple conditional unmount」)。透視投影でラベル位置を再計算する対応は
follow-upのまま。

### 検証結果

- Vitest: `cabHud.test.ts`(10件、Red→Green)・`passengerView.test.ts`の追加テスト
  (mode='cabのeyeオフセット、Red→Green)を含め`npm run test`は1081件green。
- `npm run build`(tsc+vite)green。`cargo test`(renderer_wgpu)20件green
  (D3もRust側を変更していないため無変化)。
- ブラウザ実機(デバッグシナリオ「単線行き違い」`passing-loop`、信号3基):
  東行き列車を選択→「運転台」ボタンで乗車。HUDに速度・制限速度(100)・
  次の停止点までの距離・信号現示(赤丸+「次信号: 停止」)を確認。対向列車が
  区間を空けるまで`__dbgStep`で進めると、信号現示が赤→緑(「次信号: 開通」)に
  切り替わり、速度が減速→再加速することをスクリーンショットで確認(速度表示が
  86km/h→93km/hへ変化、次の停止点までの距離も新しい安全点基準に更新された)。
  「乗車(客席)」へ切り替えるとHUDが消え、視点が運転台よりわずかに後ろへ戻る
  ことを確認(客席モードは無影響)。「降車」でクォータービューへ復帰し、
  DOMラベル(駅名・列車速度ツールチップ)も元通り表示されることを確認した。
  デッドセクション予告チップはブラウザ実機では未検証(タスク指示の
  fallback「advanced-mode manual gameで手早く確認できなければ記録するだけでよい」
  に従い、`cabHud.test.ts`の単体テスト2件(境界あり/なし)で仕様を固定するに留めた)。

### 残るfollow-up

- デッドセクション予告のブラウザ実機確認(アドバンスドモードで交直流境界を
  実際に敷設しての確認)は未実施。単体テストでロジックは固定済み。
- 次信号の現示は「予約が信号の先まで届いているか」の二値判定で、実際の閉塞方式
  (s1固定閉塞/s2〜s3の段階的現示など、将来実装される信号灯の多段階現示)には
  対応していない。将来s1〜s3を実装する際は、このHUD述語をそのまま使えるか
  再検討が要る。
- HUDのレイアウト(左下固定・幅220px)はブラウザの1回の実機確認のみで判断した
  ざっくりしたもの。デザイン調整の余地がある。
