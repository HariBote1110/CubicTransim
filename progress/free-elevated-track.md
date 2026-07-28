# 橋(applyBridge)→自由に敷ける高架線(applyElevatedPath)への作り替え

## 決定
- 旧・`applyBridge`は「両端2セルずつが坂+中間が桁」の固定構成で、直線8方向のみ・
  長さ5〜12セル限定という強い制約があった。Simutrans流に自由な高架線を敷けるよう、
  `applyRailPath`と同じ経路制約(隣接8方向を辿ればよく、曲がってもよい)で任意長の
  経路を高架にできる`applyElevatedPath(state, path, terrain?)`を新設した。
- 経路の端の扱いは次の純粋関数2つに切り出し、それぞれ単体テストした:
  - `resolveElevatedPathEnd(railMap, pos)` — その位置が既に高架(`upper.connections`
    を持つ)かどうかを返す。既に高架なら「既存の高架へ継ぎ足す」端として扱う。
  - `planElevatedPath(length, startContinuesElevated, endContinuesElevated)` —
    各セルに`{kind:'span'}`(橋桁)か`{kind:'ramp', side, level}`(坂)を割り当てる。
    継ぎ足す端には坂を作らない(高架のまま連続する)。それ以外(地平・空セル・
    行き止まり問わず)は必ずその端の2セル(外側level1・内側level2)が坂になる。
    坂の必要数が経路長を超える、または坂が継ぎ足し先の高架セルを潰してしまう
    場合は`null`を返し、`applyElevatedPath`はno-opになる。
  - 長さの上下限は設けていない(橋桁0セルの「坂だけの短い高架」も、20セル超の
    長い高架も敷ける)。
- 高架セルの下に既存の地平の線路・駅があってもよい(跨げる)。逆に高架の下に
  後から地平の線路を敷くこともできる(`applyRailPath`はupperを一切見ない)。
- 水域の上にも高架線を敷ける(坂はterrainがgrassのセルにしか置けないが、
  橋桁=span扱いのセルには地形制約を課していないため、水上を跨ぐ橋の役割を
  自然に兼ねる)。
- 撤去(`removePath`)は「橋は全部まとめて消える」旧挙動をやめ、指定した高架セル
  1枚だけを消すようにした。撤去で坂の行き先(次の橋桁 or 隣の坂)が無くなった
  場合は`revertDanglingRamps`(撤去セルの直近8方向だけを見る)がその坂を地平の
  通常線路に戻す(`ramp`フィールドだけを外す。`connections`はそのまま)。
- コストは既存の`OVERPASS_COST_MULTIPLIER`を使い、`economy.costOfElevatedPath
  (rampCellCount, overpassCellCount)`として内訳ベースで計算する形にした
  (坂=RAIL_COST、橋桁=RAIL_COST×OVERPASS_COST_MULTIPLIER)。`buildPreview.ts`の
  `evaluateBuild`は`resolveElevatedPathEnd`/`planElevatedPath`を呼んで内訳
  (`rampCells`/`overpassCells`)を求め、UIに条件を書き写さない既存方針を維持した。
  `ConstructionMode`に`'elevated'`(高架線)・`'elevated-station'`(高架駅タイル
  1枚)を追加。
- 高架セルへの駅設置は`applyElevatedStation(state, pos, towns?)`として作り直した。
  - 対象セルが高架の線路(`upper.connections`)を持たなければno-op(先に
    `applyElevatedPath`で高架を敷く必要がある)。
  - 同じ(x,z)に地平駅セルがあれば自動的に同じ駅IDへ統合する(立体交差の十字
    乗換駅は、地平と高架をそれぞれ敷いてからこの関数で重ねるだけで作れる)。
  - 隣接する高架駅セルがあれば、その駅IDへ統合する(高架ホームの延伸)。

## 廃止したもの
- `src/sim/stationTemplates.ts`(駅テンプレート機能一式: `StationTemplate`,
  `STATION_TEMPLATES`, `rotateTemplate`, `applyStationTemplate`,
  `templateAbsoluteCells`)とそのテストを削除した。テンプレートは難しいので
  タイルを1枚ずつ置く形に統一する、というユーザー判断による。
- `buildPreview.evaluateStationTemplate`を削除した。
- 旧・`buildOverpassCore`(固定長の坂+橋桁の共通ロジック)、橋の全体撤去用
  ヘルパー(`bridgeAxisOf`/`collectBridgeCellKeys`)を削除した。

## 後方互換
- `applyBridge(state, path, terrain?)`は`applyElevatedPath`への薄いラッパーとして
  残した(`pathfinding.test.ts`/`reservation.test.ts`/`simulation.test.ts`が
  引き続きこの名前で直線区間の橋を作っているため)。新規に敷く直線区間であれば
  両端2セルずつが坂になる従来通りの構成になり、これらのテストは無改修で
  通っている。
- `MAX_BRIDGE_LENGTH`定数は`economy.ts`の後方互換のため値(12)のまま残したが、
  `applyElevatedPath`では上下限として使っていない(実質未使用)。
- セーブデータの構造(`CellData.upper`/`ramp`、`StationData.cells[].layer`)は
  変更していないため、v13を新設していない(SaveDataV12のまま)。

## UI側で必要な追従(このエージェントの担当外)
`src/hooks/useGameLogic.ts` / `src/App.tsx` / `src/components/GameUI.tsx` /
`src/components/GameScene.tsx` / `src/ui/templateRotation.ts` が
`stationTemplates.ts`・`evaluateStationTemplate`を参照しておりビルドエラーに
なる。呼び出し側は次のように置き換える想定:
- 駅テンプレートの選択UI・回転(`templateRotation.ts`)・`STATION_TEMPLATES`を
  使ったプレビュー描画は丸ごと削除し、駅は地平・高架ともに1タイルずつ置く
  操作に統一する。
- `buildMode`に`'bridge'`の代わりに`'elevated'`(高架線、`applyElevatedPath`/
  `evaluateBuild('elevated', ...)`)と`'elevated-station'`(高架駅タイル、
  `applyElevatedStation`/`evaluateBuild('elevated-station', ...)`)を追加する。
  `evaluateBuild`の戻り値に`rampCells`(坂になるセル数)が増えているので、
  コスト内訳の表示に使える。
- `applyElevatedStation(state, pos, towns?)`は旧シグネチャ(`path, terrain,
  towns, stationId`)から`(state, pos, towns?)`に変わっている(高架の線路が
  既に敷いてある1セルへ駅を置くだけの関数になったため、`terrain`引数は不要、
  `stationId`は同じ(x,z)/隣接セルの駅IDを自動検出するので不要)。

## 関連progressへの追記
- `bridge-ramp-and-whole-removal.md`: 坂のlevel化・全体撤去の設計は本ファイルで
  置き換えられた(全体撤去は廃止、単セル撤去+`revertDanglingRamps`に変更)。
- `cross-elevated-station-data-model.md`: `buildOverpassCore`/`applyElevatedStation`
  の実装は本ファイルの内容に置き換えられた(データモデル自体は変更なし)。
- `station-template-ui.md` / `cross-transfer-station.md`: 駅テンプレート機能
  (`sim/stationTemplates.ts`)はユーザー判断により廃止され、タイル単位の設置に
  統一された。
