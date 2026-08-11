# 建設ロジックの純粋関数化と既知バグ5件の修正

## Decision
- `useGameLogic.commitPath` 内にあった railMap/stations の更新ロジック（rail 敷設・駅設置・車庫設置・
  シグナル巡回・撤去）を `src/sim/construction.ts` へ純粋関数として抽出した。
  - `applyRailPath` / `applyStation` / `applyDepot` / `applySignal` / `removePath`
  - いずれも `ConstructionState { railMap, stations }` を受け取り、新しい Map を返す（immutable）。
  - `commitPath` はこれらを呼んで `setRailMap`/`setStations` を一括で呼ぶだけの薄いラッパーになった
    （従来あった `setStations` の入れ子呼び出しは解消）。
- `sim-layer-extraction.md` に記載されていた既知バグ5件を、この抽出を土台に TDD で修正した。
  1. **上書き防止**: `applyStation` は対象セルが station/depot なら no-op。`applyDepot` は対象セルが
     空でなければ no-op。これにより「駅の上に車庫を置くと駅が消える」（バグ1）と「同一駅への再設置で
     重複IDが生える」（バグ2）を同時に解消。
  2. **斜め線路上の駅**: `applyStation` は既存セルが `rail` の場合、その `connections` をそのまま
     引き継ぐ。空セルへの新規設置時のみ従来通り `N|E|S|W` で初期化する。
  3. **駅名採番**: `nextStationName(stations)` を新設。`stations.size` ベースの採番をやめ、既存駅の
     `name` を走査して A から順に未使用の文字を割り当てる方式にした。孤児駅削除後も歯抜けにならない。
  4. **モード切替直後のクリック無視**: `GameScene` の `handlePointerDown`/`handleClick`/`handlePointerUp`
     が `cursorPos`（`pointermove` でのみ更新される React state）に依存していたのが原因。
     イベントの `e.point` から直接グリッド座標を算出するように変更し、hover 未発火でも正しい位置で
     建設・選択できるようにした。hover プレビュー用の `cursorPos` state 自体は残している。

## Alternatives considered
- 駅名採番を「歯抜けを許容し、末尾に追加し続ける」方式のままにする案 → 見た目上の分かりやすさ
  （A, B, C...と連番）を優先し、既存名を走査して埋める方式を採用。
- `commitPath` 内で `setRailMap`/`setStations` を関数型アップデータ（`prev => ...`）のまま維持する案
  → 建設操作は単一の同期イベントハンドラ内で完結し、他の setState と競合しないため、レンダー時点の
  `railMap`/`stations` を直接読んでも問題ないと判断し、単純化した。

## Constraints / Gotchas
- `construction.ts` の関数は THREE/React に非依存の純粋関数。新しい建設系バグはまずここに
  Vitest で再現テストを書くこと（`src/sim/construction.test.ts`）。
- `applyStation`/`applyDepot` の no-op 判定は「対象セルが埋まっているか」だけを見る。rail セルの上に
  駅を置くケース（意図的な仕様）と、station/depot セルの上に置くケース（バグだったもの）を区別する
  ため、`existing.type` で分岐している点に注意。
- ブラウザでの動作検証は `window.__debugWorld`（`railMap`/`stations`）のダンプで行った。非表示タブでは
  rAF が止まるため、`window.__dbgStep(dt, n)` を呼んで手動 tick してから読むこと。
