# 夢枠計画: 乗客視点カメラと運転モード

状態: **計画段階（未実装）**。2026-08-13 の設計会話を基に作成。
play-modes-plan.md の「遠い将来の夢（絵空事メモ）」を正式な計画へ昇格させたもの。

## 全体像

どちらの機能も「3D自前レンダラーを持っている」強みを活かす長期候補。共通の前提条件が
**透視投影カメラ**（現行は俯瞰直交投影のみ）なので、レンダラー拡張 → 乗客視点 → 運転モード
の順に積み上げる。運転モードは信号 S3（保安装置、0.5.0-Alpha-13a 実装済み）と physics.ts の
制動曲線がそのまま土台になるため、sim 層の新規実装は最小で済む見込み。

## 前提: レンダラーの透視投影対応（フェーズ D1）

現行レンダラーはクォータービュー特化で、地形シェーダ（terrain_draw.wgsl）は
ISO_X/ISO_Y/ISO_H の画面座標係数へ直接変換しており、汎用の MVP 行列を持たない。
透視投影には次のどちらかが要る:

- **案A: 汎用カメラ行列パスの追加**。カメラ uniform を「iso 係数」から「view-projection
  行列」へ一般化し、地形・メッシュチャンク・インスタンスの各パイプラインに透視モードを
  追加する。俯瞰モードは現行式と等価な正射影行列として表現できるので、最終的に1本化
  できる（が、既存の picking.ts の閉形式逆関数・chunkViewFromCamera が iso 前提なので
  俯瞰側は現行式を残すのが安全）
- **案B: 透視専用の別パス**。俯瞰は現行のまま触らず、透視カメラ時だけ別の描画パスを使う。
  地形は「コーナー標高から三角形を張る」汎用メッシュを透視用に生成する

推奨は**案B**。俯瞰側の回帰リスクをゼロにでき、両ゲート（VM層A/Mac層B）の性能基準を
既存パスで維持したまま実験できる。透視パスは車窓用に描画距離を絞れる（後述）ので、
性能要件も俯瞰とは別物になる。

D1 の成果物: `setCameraPerspective(eye, look, fovY)` を持つレンダラー API、
透視モードでの地形+メッシュチャンク+インスタンス描画、地下では坑内が暗く見える程度の
最小限の環境表現（空の色・遠景フォグ）。

## フェーズ D2: 乗客視点（車窓カメラ）

- 列車選択パネルに「乗車」ボタン。カメラを `renderPos`/`carPositions`（trackPath.ts の
  走行線）上、先頭車の少し後ろ・窓の高さに置き、進行方向を look at する
- sim 層は無改造。カメラ追従は render 層の毎フレーム処理（frameLoop の camera フェーズ）
- 描画距離: 透視パスのチャンク選択は「カメラ前方の扇形」で絞る。フォグで打ち切りを隠す
- 地下区間: トンネル内は暗い環境色＋壁面（坑内の簡易ジオメトリは D2 では省略可。
  真っ暗＋ヘッドライト風の淡い照明表現で成立する）
- 離脱はEsc/ボタンで俯瞰へ戻る。俯瞰カメラ状態は保存しておき復帰する

## フェーズ D3: 運転台視点と HUD

- 乗客視点の変種としてカメラを運転台位置へ。HUD を DOM オーバーレイで重ねる
  （wgpu 側に UI は描かない。theme.ts のトークンで速度計・ノッチ表示・次信号表示）
- HUD に出す情報はすべて既存 sim から取れる: 速度（runtimes.speedKmh）、制限速度
  （レール種別の速度上限・permittedSpeedKmh）、次の停止点までの距離（予約端）、
  次信号の現示（S1/S2 の閉塞占有状態）、デッドセクション予告（isDeadSectionBoundary）

## フェーズ D4: 運転モード本体（難易度つき）

手動運転する列車を1本選び、その列車だけ `TrainRuntime` の速度制御をプレイヤー入力で
置き換える（他列車は従来どおり自動運転。stepWorld の速度決定分岐に「手動運転中」の
フラグを1つ足すだけで、予約・閉塞・事故・き電の仕組みは全部そのまま生きる）。

入力: マスコン（力行ノッチ P1-P5）・ブレーキ（B1-B7＋非常）。キーボード（↑↓）と
画面ボタンの両対応。physics.ts の加速モデル・rampDecel がそのまま車両応答になる。

### 難易度（運転モード内の独立選択。プレイモード・信号方式とは別軸）

| 難易度 | 補助 | 停車 | 失敗時 |
| :--- | :--- | :--- | :--- |
| かんたん | ATO風。制限速度・停止点への減速は自動（TASC）。プレイヤーは出発操作と最高速度の指示だけ | 自動で定位置に止まる | 失敗が存在しない |
| ふつう | ATS-P風。照査パターン超過で自動ブレーキが介入して守ってくれる（線路の保安装置装備に関わらず常時） | 手動。±15m 以内で合格 | オーバーランは自動巻き戻し（少額ペナルティ） |
| むずかしい | 補助は**その線路・車両が実際に装備している保安装置のみ**（S3 の weakerProtection がそのまま効く）。無装備区間では何も守ってくれない | 手動。±5m 以内で合格、ホーム外停車はやり直し | 信号冒進・過速度は既存の事故システムへ直結（SPAD事故・賠償） |

- 「むずかしい」が S3 と接続するのが本命: ATS-P を整備した路線では自動ブレーキに
  救われる体験ができ、保安装置への投資が初めて肌で分かる（play-modes-plan.md の
  夢枠メモの狙いどおり）
- ダイヤ遵守評価（定時到着ボーナス）は D4 では任意。運行表（groups.ts の共有運行表）が
  あるので遅延秒数は計算できる。まず停車精度の採点だけで成立する

### 採点と経済

- 停車精度・制限遵守・乗り心地（加速度変化＝ジャーク。physics.ts がジャーク制限を
  持っているので逸脱量を測るだけ）で 100 点満点
- 報酬はまず「なし（腕試し）」で開始し、後から収入ボーナス等を検討（経済バランスを
  壊さないため）

## フェーズ分割まとめ

| フェーズ | 内容 | 規模 | リスク |
| :--- | :--- | :--- | :--- |
| D1 | レンダラー透視投影（案B: 別パス） | 大（Rust/WGSL） | 中。俯瞰パス無改造で回帰ゼロ設計 |
| D2 | 乗客視点カメラ | 中 | 小。sim 無改造 |
| D3 | 運転台視点 + HUD | 小〜中 | 小。DOM オーバーレイ |
| D4 | 手動運転 + 難易度3段階 | 中 | 中。stepWorld の速度決定分岐に手動フラグ |
| D5 | ダイヤ遵守評価・報酬（任意） | 小 | 小 |

D1 だけが大工事で、D2 以降は既存資産（trackPath・physics・S3・事故システム）の
組み合わせでほぼ完結する。**D1 の設計スパイク（透視パスで地形+チャンクが描けるか）を
最初の一歩にする**こと。

## 未決定事項

- D1 のフォグ・空の表現の程度（車窓の見栄えに直結するが、最小は単色フォグで可）
- 運転モード中の時間スケール（1x固定にするか、倍速も許すか）
- 乗客視点を「どの列車でも自由」にするか「自社列車のみ」にするか（現状全列車自社なので同義）
- トンネル坑内の壁ジオメトリ（D2では省略可。第三軌条見た目のfollow-upと合わせて後日）
- モバイル/タッチでのマスコン操作（当面キーボード＋画面ボタンで開始）

---

## 実装メモ(D1〜D3スパイク、`feature/perspective-camera`ブランチ)

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
- HUDのレイアウト(左下固定・幅220px)はブラウザの1回の実機確認のみで判断した
  ざっくりしたもの。デザイン調整の余地がある。

## マージ後の再整合(`feature/stopping-and-diorama-visuals`統合、0.5.0-Alpha-14b)

D1〜D3は`feature/perspective-camera`をmainlineの0.5.0-Alpha-8f相当から分岐して
作業していたため、同時期にmainlineで進んでいたPM1-PM4完結・S1-S3信号方式・
軌道(レール種別)・レビュー対応(H1-H4/M1-M7/L1-L6)を知らずに実装していた。
`git merge origin/feature/stopping-and-diorama-visuals`で取り込み、以下を再整合した。

- **コンフリクト**: package.json(バージョン、14bを採用)・progress/dream-modes-plan.md
  (add/add、双方の文書を`---`区切りで連結)・progress/INDEX.md(双方のエントリを
  結合)・src/App.tsx/src/components/GameUI.tsx(S2/S3のprops
  `signalKind`/`purchaseProtection`とD2/D3のprops`ridingTrainId`/`ridingMode`が
  同じ箇所に追加されていただけの純粋な加算コンフリクト、両方保持)。
  src/sim/simulation.ts・GameScene.tsx・useGameLogic.tsは自動マージ成功(無介入)。
  列車インスペクタの乗車ボタンと車庫の保安装置選択UIはそもそも別セクションで、
  コンフリクトすら起きなかった。
- **cabHud.tsの再整合**(TDD、Red→Green):
  - `speedLimitKmh`: `rules.trackClasses`が有効なら現在セルのレール種別に応じた
    上限(physics.tsの`railWeightSpeedCapKmh`、テーブルはそのまま参照・複製せず)、
    無効なら`MAX_SPEED_KMH`にフォールバック。
  - `nextSignalAspect`: `reservedEndIndex`が信号のindexまで届いていれば従来どおり
    green即決。届いていない場合、s0はredのまま。s1/s2/s3では
    `reservedEndIndex`の遅れ(列車がまだ制動距離圏内に入っておらず予約延長を
    試みていないだけの状態)に引きずられて誤ってredと報告しないよう、信号セル
    そのものを起点に`findSafeSegmentEnd`/`entrySignalKindFor`/`blocksSegmentEntry`
    (いずれもsimulation.tsから可視性のみの変更でexport)を直接呼び、
    「信号の先のブロックが今まさに予約可能か」をその場で評価するよう変更した。
    (旧メモの「将来s1〜s3を実装する際は再検討が要る」というfollow-upは、この
    変更で解消した。)
  - `deadSectionAhead`は無改造(`isDeadSectionBoundary`はS1-S3以前から存在)。
- **検証**: `npm run test`は1081件→**1175件**(mainline分の増分+cabHudの新規テスト
  4件)、`npm run build`・`cargo test`(20件、Rust側は無変更)・
  `npm run build:renderer`いずれもgreen。ブラウザ実機で(a)クォータービュー起動の
  健全性、(b)デバッグシナリオ「単線行き違い」で運転台に乗車しHUDの信号現示が
  対向列車の解放で赤→緑に切り替わることを再確認、(c)リアリスティック+保安装置
  (S3)モードで実際に車庫から電車(保安装置ATS-P)を購入・出庫し、車庫の
  保安装置選択UIと列車インスペクタの乗車(客席)/運転台ボタンの両方が問題なく
  機能すること、運転台HUDの制限速度がtrackClasses有効時にMAX_SPEED_KMH(100)
  ではなくレール種別の上限(110、既定50kgNレール)を表示することを確認した。

## 実装メモ(D4 手動運転+難易度3段階、`feature/perspective-camera`ブランチ、0.5.0-Alpha-15a)

状態: **D4完了**。手動運転する列車を1本選び(`SimWorld.manualDrive`、同時に1本まで)、
かんたん(ATO)/ふつう(ATS-P常時)/むずかしい(実装備のみ)の3難易度で速度制御・
信号無視(SPAD)・停車精度採点を実装した。新規`src/sim/manualDrive.ts`(ノッチ↔割合の
対応表・かんたんの速度キャップ・むずかしいの保安装置有効判定・停車精度の許容誤差・
SPAD強行の可否、いずれも純関数)を土台に、simulation.tsへ最小侵襲で配線した。

### ノッチ

マスコン(力行)P1〜P5、N、ブレーキB1〜B7、非常(EB)の14段。キーボード(↑↓・
Space=EB)と画面ボタンの両対応(`CabHud.tsx`)。P1=20%〜P5=100%(既存の
`computeAcceleration`の結果に掛ける割合)、B1=1/7〜B7=1.0(既存の`DECEL_KMH_S`相当に
掛ける割合)、EBは既存の`EMERGENCY_DECEL_KMH_S`をそのまま使う。新しい力行・制動の
物理モデルは持ち込んでいない(既存のphysics.ts/simulation.tsの定数を割合で薄めるだけ)。

### stepTrainへの配線

`SimWorld.manualDrive?: { trainId, notch, difficulty, tally }`を追加。stepTrain内の
既存の速度制御(hardEnvelopeKmh/releaseEnvelopeKmhの計算は無改造で共有)に対し:

- **かんたん(ATO)**: 既存の自動制御チェーンにノータッチ。`releaseEnvelopeKmh`の
  `Math.min`にノッチ由来の速度キャップ(`easyModeSpeedCapKmh`)を1項追加しただけ。
  停止点への減速・駅停車判定(`stopAtStation`)はすべて既存の自動運転と同一。
- **ふつう/むずかしい**: 新設`applyManualSpeedControl`が既存のif/elseチェーン
  (immediateBlock〜だらだら加速)を丸ごと置き換え、ノッチ由来の加速度をそのまま
  積分する。保安装置による自動ブレーキは、既存の`hardEnvelopeKmh`(停止点・
  trackClassesを織り込んだ絶対上限、無改造で再利用)を超えたときに介入する形で
  実装。ふつうは常時介入、むずかしいは`equippedProtectionActive`(ATS-P/ATC/CBTC
  装備時のみ、ATS-Sや未装備はfalse=SPAD確率テーブルで実際に守ってくれない強さと
  揃えた)。物理的な衝突安全網(`immediateBlock`、他列車の直前占有)は難易度に
  関わらず常に効く(=文字どおり他列車へめり込むことは無い)。
- **むずかしいのSPAD**: `ensureReservation`の2箇所の`blocksSegmentEntry`判定に
  `manualForcesEntry`を追加。保安装置が実際に効かない区間でプレイヤーが力行ノッチを
  入れているときだけ判定結果を無視して予約を強行させ、`evaluateSpadOnce`
  (force引数を追加、S3と同じ`SPAD_CHANCE`テーブルを共用)の確率判定に委ねる。
  ただし物理的なセル予約(`tryReserve`)自体は常に効くため、他列車が実際に保有する
  セルへ literally 重なることは無い(信号は無視できても、目の前の列車は避けられない
  という設計)。

### 停車精度スコア

「距離ベースの±15m/±5m判定」は、この sim の移動モデル上、経路末尾(駅の停止点)への
到着は常に幾何学的にスナップする(`arriveAt`到達判定、手動/自動で共通)ため、
オーバーラン自体は起こり得ない。そこで「駅への進入中に速度がほぼ0まで落ちる
(=プレイヤーが早めに完全停止してしまう、undershoot)」ことを唯一の失敗モードとして
採点する設計にした。`obstacleType==='station'`かつ`rt.speedKmh`が
`MANUAL_STOP_DETECT_KMH`未満に落ちた瞬間を1回だけ判定し(`distanceToStopPoint`を
再利用)、`manualStop`イベントを発行してタリー(停車回数・合格回数・平均誤差・
超過秒数・非常制動回数)へ加算する。既に停車を終えて発車待ちの状態から再度動き出し、
最終的に幾何学的スナップで到着した場合も、undershootのスコアはそのまま残る
(実運用の「一度停止したらそこがその回の停車」という判断に合わせた)。

ブラウザ実機では、単線行き違いシナリオで信号待ちのため一時停止した直後に
`obstacleType`が最終駅へ切り替わるタイミングと重なり、大きな誤差(数百m)が
記録されるケースを確認した。これは想定内の既知の粗さで、「途中の信号待ちでの
停止」と「駅への進入中の停止」を区別する情報がstepTrain側に無い(safe waiting
pointの種別しか分からない)ことに起因する。より精密にするには、経路上の残り
セル数が閾値以下(=本当に駅の直前)のときだけ採点する等の絞り込みがfollow-up候補。

### UI(CabHud.tsx)

運転台へ乗った直後、`world.manualDrive`がまだこの列車を指していなければ難易度
ピッカー(かんたん/ふつう/むずかしい)を先に出す。選択するとD2/D3の`riderState`と
同じパターンで`world.current.manualDrive`を直接書き換える(Reactステート経由だと
ポーリング間隔ぶん遅れるため)。ノッチはキーボード(↑↓・Space)と画面ボタンの
両対応、停車中(速度<1km/h)は「出発する」ボタンでP3ノッチへ、難易度バッジ、
停車採点トースト、乗車タリーを表示する。降車時は`world.manualDrive`を`undefined`へ
戻し自動運転へ復帰させる(ブラウザ実機で降車→`__debugWorld.manualDrive`が
`undefined`に戻ることを確認済み)。

### 検証結果

- Vitest: `manualDrive.test.ts`(純関数26件)・`manualDriveIntegration.test.ts`
  (stepWorld結合6件、かんたんの速度キャップ・ふつうの自動ブレーキ介入・むずかしいの
  超過秒数記録・SPAD強行と保安装置装備時の非強行・停車精度イベント)・
  `cabHud.test.ts`追加3件を含め、`npm run test`は1201件→**1210件**。
  `npm run build`(tsc+vite)・`cargo test`(20件、Rust側は無変更)・
  `npm run build:renderer`いずれもgreen。
- ブラウザ実機(デバッグシナリオ「単線行き違い」): 運転台に乗車→難易度ピッカーで
  「ふつう」選択→キーボード↑↑↑でノッチがN→P1→P2→P3に進むこと、駅接近中は
  P3(力行)を入れていても自動ブレーキ(`hardEnvelopeKmh`超過の介入)で速度が
  73km/h→30km/h前後まで落ちて停止点手前で待たされること(保護が働いた証跡)、
  信号解放後に次信号表示が赤→緑に切り替わり再加速することを確認。
  降車→再乗車で「かんたん」を選択し、P2ノッチ(MAX_SPEED_KMHの40%=40km/h)へ
  設定すると、既存の自動制御がそのまま走りつつ速度がちょうど40km/hで頭打ちに
  なることを確認(`__debugWorld.manualDrive.notch='P2'`のまま150tick進めても
  `rt.speedKmh`が40を超えない)。むずかしいのSPAD強行(信号の先が保安装置未装備の
  占有ブロックのとき、プレイヤーが力行を入れ続けると予約が強行され、確率で
  `accident`イベント(`kind:'spad'`)が発火する挙動)と、保安装置(ATS-P)が
  実際に装備されている場合はむずかしいでも強行しない挙動は、
  `manualDriveIntegration.test.ts`の結合テストで固定した(ブラウザではデバッグ
  シナリオがs0固定でブロック索引を持たないため、s1のセットアップが必要な同テストは
  ユニット側の検証に委ねた)。

### 残るfollow-up

- 停車精度スコアの「途中停止 vs 駅進入中の停止」誤判定(上記)。
- D5(ダイヤ遵守評価・報酬)は未着手のまま。
- 経済との接続(タスク仕様どおり意図的に未接続。D5で検討)。
- むずかしいのSPAD確率ロールは既存のS3のSPAD_CHANCEテーブルをそのまま流用しており、
  「プレイヤーが手動で信号を無視した」場合と「S3の自動運転が信号待ちに入った」場合を
  区別していない。手動運転はプレイヤーの意図的な行為なので、確率をS3より高くする
  (「わざと」やっている分、危険度を上げる)といった調整の余地がある。

## マージ最終確認: 性能ゲート(D1レンダラー変更の回帰確認)と統合ブランチへの合流

D1(透視投影パス追加)・renderer_wgpuのモジュール分割(lib.rsから
edits.rs/mesh_pipeline.rs/meshes.rs/perspective.rs/projection.rs/wasm/*.rsへ分離)を
含むため、`progress/quarterview-renderer-spec.md`が定める性能ゲート(層A/層B)を
マージ前に再確認した。クォータービュー描画パス自体はバイト単位で無改造(D1のメモ参照)
なので回帰は無い想定だが、実測で確認する。

### 層B(Mac / Apple M4 / Metal、3回計測、`renderer/renderer_wgpu` の `layer_b_bench`
release バイナリ、`cargo run --release --bin layer_b_bench -- <out.json>`)

T1〜T7 のstrict閾値すべて3回とも全pass(T8はプロトタイプスコープ外、既定どおりpass:null)。

- run1: T1 median 0.652ms/p99 1.289ms、T2 median 0.383ms/p99 0.984ms、T3 hitch 0/10260、
  T4 median 2.443ms/p99 3.109ms、T5 hitch 0、T6 firstFrame 8.40ms、T7 median 0.0ms/p99 0.0ms。
- run2: T1 median 0.651ms/p99 1.323ms、T2 median 0.384ms/p99 1.071ms、T3 hitch 0/10260、
  T4 median 2.443ms/p99 3.092ms、T5 hitch 0、T6 firstFrame 6.20ms。
- run3: T1 median 0.653ms/p99 1.353ms、T2 median 0.382ms/p99 1.087ms、T3 hitch 0/10260、
  T4 median 2.439ms/p99 3.084ms、T5 hitch 0、T6 firstFrame 6.87ms。

R4系の既存メモ(T1 median≈0.6〜0.65ms、T4 median≈2.4ms)と同じ数値帯で、D1の透視パス
追加・モジュール分割による回帰は無いことを確認した。なお最初の実行は`-- --help`を
出力先パス引数として渡してしまう操作ミス(バイナリの第1引数=出力JSONパスであり
`--help`オプション自体は存在しない)で、その回だけzoom-roundtrip中に1フレームの
ヒッチ(cpuMs max 265ms、システム側のスケジューリング由来と推測)を観測したため
正式な計測から除外し、上記の3回はすべて出力パスを明示した回で撮り直した
(ファイル`--help`は誤操作の産物として削除済み)。

### 層A(VM・headless、`node renderer/bench/run-layer-a.mjs --browser-exact
--check-ts-migration`)

**このMac(層Bの実行環境)からは実行していない。** 層Aの定義(基準ベンチ環境=
i5-13400F上のUbuntu Server VM、借用スライス、SwiftShader/Lavapipeソフトウェア
ラスタライザ)は特定のVM環境そのものを指しており、このスクリプトを技術的にMac上で
実行すること自体は可能でも、Metal(実GPU)バックエンドの結果になり層Aが厳格判定する
「CPU側パイプラインとVM環境での挙動」の代わりにはならない(見せかけの計測になる)。
このセッションにはそのVMへのアクセス手段が無いため、層Aは**未実施**として記録する。
D1の変更(透視パス追加はコンピュート側のノイズ・タイル生成を触っていない、
lib.rsのモジュール分割は関数の再配置のみで内容は不変)から、層AのA1〜A8が影響を
受ける可能性は低いと考えられるが、これは推測であり実測ではない。次に層Aを回せる
環境(VMアクセスがある回)で必ず確認すること。

### 統合ブランチへの合流

`git fetch origin`で確認したところ`origin/feature/stopping-and-diorama-visuals`は
このブランチをフォークした時点(53bc17f)から動いていなかった。そのため
`feature/perspective-camera`を`feature/stopping-and-diorama-visuals`へ統合する作業は
コンフリクトの無い**fast-forward**だった(このworktreeでは元のfeature/perspective-camera
ブランチが既にチェックアウト済みのため、一時ローカルブランチ
`tmp-ffm-stopping-diorama`をorigin/feature/stopping-and-diorama-visualsから作成し、
そこへfeature/perspective-cameraをfast-forwardマージしてから
`git push origin tmp-ffm-stopping-diorama:feature/stopping-and-diorama-visuals`で反映、
作業後に一時ブランチを削除した。force-pushは使っていない)。マージ後の状態で
`npm run test`(1210件)・`npm run build`・`cargo test`(20件)・`npm run build:renderer`
をすべて再実行しgreenを確認した。
