# 透視投影カメラ(乗客視点)実装メモ — D1スパイク

状態: **D1スパイク完了**(`feature/perspective-camera` ブランチ、`main`未マージ)。
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
