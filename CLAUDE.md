# CubicTransim

OpenTTD・A列車で行こう系を目指すインフラ整備ゲームのプロトタイプ。React + TypeScript + Vite + react-three-fiber。

## コマンド

- `npm run dev` — 開発サーバ (port 5173)
- `npm run test` — Vitest（純粋ロジックのテスト）
- `npm run build` — tsc -b && vite build（型検査込み。コミット前に必ず通すこと）

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
  - `terrainEdit.ts` — OpenTTD風の地形編集(盛土/切土)。矩形選択を±1段し、段差1以下を方向つきBFS伝播で回復。線路・町・水域・範囲外が絡む編集は同一参照のno-op
  - `terrain.ts` — 標高が一次データ（`heights: Map<string, number>`、セルごとの整数段数・未登録=0・最大 `TERRAIN_HEIGHT_MAX`=10）。`generateMap` がノイズ生成→`normaliseHeights`（隣接段差1以下を保証）→地形種別導出（標高1以上=mountain）の順で作る。`computeElevation` は旧セーブ移行専用
- `src/hooks/useGameLogic.ts` — React state（railMap/stations/trains）と `worldRef: SimWorld` の同期、建設・購入ロジック
- `src/components/` — 描画専任。`SimulationDriver` が useFrame から stepWorld を呼ぶ。`DynamicTrain` は runtime.renderPos を反映するだけ
- `src/render/` — 描画専用のパレット・共有マテリアル・ジオメトリ生成。sim層からは参照しない
- `src/ui/theme.ts` — GUIのデザイントークン。UIの配色・角丸・余白・ボタンはここを経由すること（インラインstyleの直書きを増やさない）
- 設計判断・既知バグは `progress/INDEX.md` から辿ること

## ブラウザでの動作検証手順（エージェント向け）

Browser ツール（`mcp__Claude_Browser__*`）で検証する。`preview_start` で name "dev" のサーバを起動（.claude/launch.json 設定済み）。

**重要な注意点:**

1. **非表示タブでは requestAnimationFrame が止まり、シミュレーションが進まない**。列車の走行検証は画面を眺めるのではなく、`javascript_tool` で手動 tick する:
   - `window.__dbgStep(dt, n)` — stepWorld を dt 秒 × n 回進める（SimulationDriver が公開）
   - `window.__debugWorld` — SimWorld（railMap/stations/trains/runtimes）を直接読める
   - 例: `window.__dbgStep(0.1, 100)` で10秒進め、`__debugWorld.runtimes` の grid/speedKmh/debugStatus を確認
2. **同期 JS ループ内では arrive イベント→React の scheduleIndex 更新が反映されない**（バッチング）。複数駅の走行検証は `__dbgStep` を複数回の `javascript_exec` に分けて呼ぶこと
3. **クリック座標は screenshot の 1/2**。screenshot は 1600x900 相当で返るが、click/hover 座標は 800x450 空間。画像上の対象位置の座標を 2 で割って渡す
4. **キャンバス操作の前に必ず同座標へ hover してから click/drag する**（cursorPos が pointermove で更新されるため。省くと直前の位置に建設される）
5. 建設結果の確認は screenshot より `__debugWorld.railMap` のダンプが確実
6. カメラ初期状態では画面中央が原点付近。世界 +x は画面右下方向（1セル ≈ click座標で (+30,+17)）。画面横方向のドラッグは斜め線路になるので注意

## 描画の注意点

- ジオメトリのマージは `render/mergeGeometry.ts` の `mergeAndDispose()` を使う。three の
  `mergeGeometries` は index 付き（Box/Cone/Cylinder）と index 無し（Octahedron/Icosahedron）が
  混ざると黙って null を返す
- `shadow-camera-*` を JSX に書いても react-three-fiber は `updateProjectionMatrix()` を
  呼ばないため効かない。ref 経由で設定すること（`GameScene.tsx` の `SunLight`）
- 光源はカメラと同じ側（+x,+y,+z）に置くと影が物体の裏に隠れて見えない。`-x` 側からの横光にする
- `<Environment preset="...">` は外部HDRを取得するのでオフラインでは失敗する。使わない

## 規約

- ゲームロジックの変更は TDD（Red→Green→Refactor）。テストとコミットをこまめに
- コミットメッセージは日本語、末尾に `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 識別子・コード内英語は British English（colour, serialise 等）
- ユーザー向け文書・progress/ は日本語
