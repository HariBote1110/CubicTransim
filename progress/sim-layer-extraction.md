# シミュレーション層の分離（フェーズ1中核）

## Decision
- 列車の走行ロジック（経路探索・速度制御・閉塞・到着判定）を React コンポーネントから純粋な `src/sim/` 層へ分離した。
  - `sim/pathfinding.ts` — BFS 経路探索の純粋関数（THREE 非依存）
  - `sim/simulation.ts` — `stepWorld(world, dt)`。走行状態は `TrainRuntime`（ミュータブル）に保持
  - `components/SimulationDriver.tsx` — useFrame から `stepWorld(dt × simSpeed)` を呼ぶだけの薄いドライバ
  - `components/DynamicTrain.tsx` — 描画専任（runtime.renderPos/renderTarget を反映するのみ）
- 理由: 旧実装は走行状態が React state で、毎タイル setState する構造。一時停止・倍速・セーブ・複数列車のすべてを阻害していた。
- `TrainData`（React state）は静的データ（id/schedule/scheduleIndex/status/初期位置）のみ。動的状態（位置・速度・経路・占有セル）は `TrainRuntime` に一本化し、旧 `reservedPath`/`occupiedCells` の React 同期は廃止。
- 駅停車は `setTimeout(3000ms)` → シミュレーション時間 `stopRemaining`(3秒) に変更（意図的仕様変更。一時停止・倍速に正しく追従させるため）。

## Alternatives considered
- 状態管理ライブラリ（zustand 等）の導入 → 依存を増やさず `useRef<SimWorld>` + 同期 useEffect で十分と判断。
- 経路再探索の「1秒スロットル」再現 → 単純化して「経路が空なら毎 tick 再探索」に統合。列車数が増えて問題になったら再検討。

## Constraints / Gotchas
- **非表示タブでは rAF が止まり、シミュレーションも止まる**。ブラウザ自動化での検証には `window.__dbgStep(dt, n)`（SimulationDriver が公開するデバッグフック）で手動 tick すること。`window.__debugWorld` で SimWorld を覗ける。意図的に残している。
- `__dbgStep` を同期ループで大量に回すと、arrive イベント→React の scheduleIndex 更新が**次の JS 実行まで反映されない**（React バッチング）。実フレーム駆動では問題ない。
- worldRef の railMap/stations/trains は React state の immutable 差し替えを useEffect で代入同期。`runtimes` の Map インスタンスだけは維持する（描画側が参照を保持）。
- 既知バグ（今回のスコープ外、未修正）:
  1. 駅・車庫の設置が既存セルを**無条件上書き**する（駅の上に車庫を置くと駅セルが消え、StationData が孤児として残る）
  2. 同一セルへ駅を再設置すると別 ID の駅が重複生成される（隣接マージは NESW 隣接のみで自セルを見ていない）
  3. 駅設置はセルの connections を N|E|S|W で上書きするため、**斜め線路上の駅は列車が進入不可**になる
  4. ビルドモード切替直後の 1 回目のキャンバスクリックが無視されることがある（実機マウスでは未確認、自動化環境で顕著）
  5. 駅名採番が孤児駅もカウントするため飛ぶ（Station A の次が Station C になる）
