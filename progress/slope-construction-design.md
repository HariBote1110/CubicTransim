# P7: 標高上の建設(勾配レール)の設計

## Decision

OpenTTD の傾斜モデル(progress/openttd-slope-notes.md)を簡約して導入する。方針は
**「まず foundation(基礎)なしの OpenTTD」**: 建てられる形を絞る代わりに実装を薄く保ち、
足りなければ地形編集(terraform)で整地してもらう。terraform は既に P2 で TTD 同等の
ものが入っているため、このトレードオフはゲームとして成立する。

1. **セル形状は cellCornerHeights から都度導出**(保存しない)。分類は
   `slopeOf(corners)`: `flat`(4隅同値) / `incline`(一辺の2隅が+1: N/S/E/W の4種) /
   `other`(1隅・3隅・対角など)。急斜面(段差2)は 1-Lipschitz 保証により存在しない
2. **線路の建設可否**:
   - `flat` セル: 任意の標高で従来どおり全方向可(駅・車庫・信号も flat なら任意標高で可)
   - `incline` セル: 傾斜軸に沿った直進のみ可(N傾斜なら N-S 接続のみ)。カーブ・分岐・
     駅・車庫・信号は不可
   - `other` セル: 線路不可(整地してから)。foundation は将来拡張(導入するなら
     openttd-slope-notes.md の leveled foundation 4ケース簡約に従う)
3. **接続の標高連続性**: 隣接セルの線路が繋がる条件は「共有辺の2隅の標高が両セルで一致」。
   flat同士は同標高、incline は低い側の辺が隣の flat と、高い側の辺が+1 の flat と繋がる
   (=1セルで1段登る。OpenTTD と同じ勾配レート)
4. **mountain 概念の廃止**: `terrainTypeAt` の mountain は「建設不可の障害物」ではなくなり、
   「標高1以上」の表示上の区分に格下げする。旧・山岳トンネル規則(坑口・内部非表示)は
   「線路の走行標高より地形が高い区間」に対して適用する形へ一般化する(高架トンネルの
   isMountainInteriorAtLevel と同型の判定を地上レールにも使う)
5. **列車の高さ・姿勢**: 走行線(trackPath)の各点で標高をコーナー双線形補間し、
   renderPos.y に反映。既存の高架 ramp の pitch 計算(前後台車ベース)を流用する
6. **町・水域**: 町タイルは当面 flat セルのみ(標高任意)。水域は従来どおり標高0固定
7. **経路探索・予約**: セル接続グラフ自体は connections ビットのまま(建設時に標高連続性を
   保証するので、走行時は従来ロジック無改修が原則)。高架(uppers)との相互作用:
   高架レベルは「地表標高+level」ではなく従来どおり絶対レベルとして維持し、
   標高のあるセルへの高架は当面禁止のまま(P8地下と合わせて後日一般化)

## 実装順(サブフェーズ)

- P7a: sim/slopes.ts 新設 — slopeOf / 線路可否 / 辺標高の連続性判定(純関数、TDD)。additive
- P7b: construction.ts 統合 — 「mountain=不可」を標高規則へ置換、パス建設の連続性検証、
  トンネル規則の一般化、コスト(incline セルは割増)
- P7c: 描画 — trackGeometry/trackPath の標高追従、TerrainBlocks は既に傾斜メッシュ対応済み、
  列車の y/pitch、建設プレビューの標高表示
- P7d: 駅・車庫・信号の任意標高化、町タイルの標高対応、UI フィードバック

## Alternatives considered

- **foundation 完全実装(TTD忠実)**: 初手では棄却。傾斜×線路方向のテーブルと基礎描画の
  工数が大きく、「整地すれば同じことができる」ため優先度が低い。P7d 以降の拡張余地として残す
- **勾配を2セルで1段(緩勾配)**: 既存の高架 ramp が「1セルで OVERPASS_HEIGHT」の急坂で
  確立しているため、整合を優先して1セル1段を採用

## Constraints / Gotchas

- 標高連続性は「建設時に保証」する設計なので、terraform で線路セルの標高を変える編集は
  従来どおり blockers で禁止のまま(これを緩めると走行時検証が必要になる)
- trackPath の y 補間は「セル中心線に沿った断面標高」であり、コーナー標高の双線形と
  厳密には一致させること(レールと列車のずれ防止。CLAUDE.md の trackPath 原則)

## P7a実装メモ

- `src/sim/slopes.ts` を新設(construction.ts/描画には未配線、additive)。
  `slopeOf`/`allowedRailConnections`/`edgeHeights`/`railEdgeContinuous`/
  `canPlaceFlatStructure`/`pathSlopeViolations`/`SLOPE_RAIL_COST_MULTIPLIER`(=2)を実装。
- `edgeHeights` はコーナー順を `N:[nw,ne] S:[sw,se] E:[ne,se] W:[nw,sw]`、対角は共有1頂点を
  2要素とも同値で返す規約にした。実物の `TerrainField`(コーナーが隣接セル間で物理共有される)
  なら、隣接セルの `edgeHeights` は常に要素ごと一致する(=`edge-discontinuous` は構造的に
  発生しない)。このケースをテストするにはコーナー共有を無視する field ダブルが必要だった
  (`slopes.test.ts` 参照)。実運用では `pathSlopeViolations` の他チェック
  (`other-slope`/`direction-blocked`)の方が主戦場になる見込み。
- `pathSlopeViolations` は construction.ts の `mountainCellCandidateDirs` と同型の
  「path[i]がprev/nextへ向かう方向」導出を流用しつつ、行き止まりの反対側候補は追加しない
  (山岳坑口ルールと違い、勾配可否判定には実際に必要な接続方向だけを見れば足りるため)。
