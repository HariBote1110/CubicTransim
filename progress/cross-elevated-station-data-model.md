# 立体交差の十字乗り換え駅: データモデルと建設ロジック(第1段階)

## Decision

- **高架駅セルの判定方法**: `CellData.upper` に `stationId?: string` を追加した。
  「`upper` を持ち、かつ `upper.stationId` がある」セルが高架ホームである。
  `upper` はあるが `stationId` が無い(=`undefined`)場合は単なる橋桁(駅ではない)を意味する。
  この区別は後段(予約の `isSafeWaitingPoint` が橋桁上では停止不可・高架駅では停止可)に必須。
- **StationData.cells の層**: 各セルに `layer?: 0 | 1` を追加(省略時0=地平)。1つの駅ID
  (`StationData`)に地平ホーム群(layer省略/0)と高架ホーム群(layer:1)が両方ぶら下がる形にした。
  同じ`(x,z)`でも layer が異なれば別セルとして共存できる(立体交差の核心である
  「地平駅の真上を高架駅が跨ぐ」1セルは、地平セル`{x,z}`と高架セル`{x,z,layer:1}`の
  両方が同じ`StationData.cells`に入る)。
- **applyBridgeとapplyElevatedStationの共通化**: 坂(両端2セルずつ、ramp level1/2)+
  橋桁(中間セル、upper.connections)を組み立てるロジックを `construction.ts` の
  内部関数 `buildOverpassCore(state, path, terrain, allowStationSpan)` に切り出した。
  `applyBridge` はこれを `allowStationSpan=false` で呼ぶ(従来通り)。
  `applyElevatedStation` は `allowStationSpan=true` で呼び、橋桁セル(=中間セル全て)を
  無条件でホーム扱いにして `upper.stationId` を設定する。
- **ガード緩和の範囲(安全側の判断)**: `buildOverpassCore` の橋桁セル検証は、
  「車庫なら常に禁止」「駅(地平)なら `allowStationSpan` の場合のみ許可」に変えた。
  つまり **地平駅の上を高架駅・高架橋が跨ぐことは許可**したが、
  **「地平駅の上に、駅でない単なる橋桁(`applyBridge`)を架ける」ことは引き続き禁止**のままにした。
  理由: 後者を許可する具体的な要求(ユースケース)が今回の仕様に無く、
  地平駅の直上に「駅でも無い高架線路」が通る組み合わせは、描画・予約側の設計判断
  (地平駅ホーム上に架線柱のない橋桁が浮く見た目、等)が定まっていない状態で
  先に許可を広げるのはリスクが高いと判断したため。将来この組み合わせが必要になれば
  `applyBridge` にも `allowStationSpan` を露出させるオプション追加で対応できる
  (`buildOverpassCore` 自体はどちらも既にサポートしている)。
- **地平駅connectionsの不変性**: 橋桁セルが地平駅の場合、地平の `connections`/`type`/
  `stationId` は一切変更しない(高架は独立した層のため)。数式上は
  `(X | axisBits) & ~axisBits === X & ~axisBits` が成り立つため、既存の
  「橋桁の下の地平connectionsから軸ビットだけ引く」処理をそのまま流用でき、
  駅かどうかで分岐する特別なコードは不要だった(通常セルと同じ式で安全に成立する)。
- **駅テンプレート(`cross-elevated`)**: `TemplateCell` に `layer?: 0|1` と
  `overpassLine?: boolean` を追加した。ramp・upperは `applyBridge`/`applyElevatedStation`
  専用のロジックでしか作れないため、`overpassLine:true` を持つセル群は
  `applyStation`/`applyRailPath` の対象から外し、`applyStationTemplate` が
  軸方向に並べ替えて1本のpathにまとめ、`applyElevatedStation` へ一括で渡す。
  テンプレート構成: 地平ホーム(軸A、南北)5セル(dz=-2..2, dx=0) + 高架オーバーパス
  (軸B、東西)7セル(dx=-3..3, dz=0; 坂2+橋桁=ホーム3+坂2)。中心`(0,0)`だけが
  両方に属し、そこが立体交差の交点になる。地平側を先に `applyStation` で設置してから
  高架側を `applyElevatedStation` に渡す際、交点セルの既存 `stationId` を検出して
  同じ駅IDへ統合する。
- **コスト**: `evaluateStationTemplate` は `layer:1` の駅セルに
  `STATION_COST × OVERPASS_COST_MULTIPLIER` を掛ける(橋と同じ倍率)。
- **SaveData v12**: `StationData.cells[].layer` と `CellData.upper.stationId` の追加に
  伴い新設。どちらもオプショナルフィールドなのでv11の構造をそのまま再利用できるが、
  区切りとしてバージョンを上げた。`migrateStations` で `layer ?? 0` を明示的に補う
  (v11以前は「高架駅なし・全セルlayer0」として読み込める)。`upper.stationId` は
  元々オプショナルなため明示マイグレーション不要(未定義のまま読み込んでも安全)。

## 確定インターフェース(後続エージェント向け)

```ts
// src/types.ts
interface CellData {
  // ...
  upper?: { connections: number; stationId?: string };
  // 高架駅セルの判定: !!cell.upper && !!cell.upper.stationId
}
interface StationData {
  // ...
  cells: { x: number, z: number, layer?: 0 | 1 }[]; // layer省略/0=地平, 1=高架
}
```

```ts
// src/sim/construction.ts
function applyElevatedStation(
  state: ConstructionState,
  path: Pos[],                 // 坂2+橋桁(N>=1)+坂2の一直線。applyBridgeと同じpath形式
  terrain?: Map<string, TerrainType>,
  towns?: TownData[],
  stationId?: string,          // 省略時は新規駅。渡すと既存駅(通常は地平ホーム)へ統合
): ConstructionState;
// path.length未満MIN_BRIDGE_LENGTH/超過MAX_BRIDGE_LENGTH、直線でない、坂が水域山岳、
// 橋桁が車庫、橋桁に既にupperがある → 失敗しstateをそのまま返す(no-op)。
// 成功時、橋桁セル(path.slice(2, -2))全てが upper.stationId を持つホームになる。
```

```ts
// src/sim/stationTemplates.ts
interface TemplateCell {
  dx: number; dz: number; kind: 'station' | 'rail'; axis: StationAxis;
  layer?: 0 | 1;        // 1なら高架ホーム(kind必ずstation、overpassLineも必須)
  overpassLine?: boolean; // trueならapplyElevatedStationでまとめて処理される
}
// STATION_TEMPLATESに 'cross-elevated' を追加(地平ns5セル+高架ew7セル、中心のみ共有)
```

新セーブ: `serialiseWorld` は `version: 12` を返す。`deserialiseWorld` は v9〜v12を
同じ経路で処理し、`migrateStations` が `cells[].layer` を `?? 0` で補う。

## 積み残し(後続エージェントへの申し送り)

- `pathfinding.ts` / `reservation.ts` / `simulation.ts` / `trackPath.ts` は今回未着手。
  高架駅セル(`upper.stationId`あり)を安全な待機点として扱う分岐、地平⇄高架の
  乗換え(同一`StationData`内でlayerが異なるセル間の乗客導線)、列車がその層へ
  進入・停車できるようにする経路探索・予約の拡張が必要。
- 描画(`src/components/` / `src/render/`)も未着手。高架ホームの見た目
  (上屋・ホーム柵など)は既存の橋桁描画に「駅らしさ」を足す形になる想定。
- `applyBridge` に `allowStationSpan` を露出するかどうかは保留(上記Decision参照)。
