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

- 描画(`src/components/` / `src/render/`)も未着手。高架ホームの見た目
  (上屋・ホーム柵など)は既存の橋桁描画に「駅らしさ」を足す形になる想定。
- `applyBridge` に `allowStationSpan` を露出するかどうかは保留(上記Decision参照)。

## 第2段階: 経路探索・予約・走行ロジックの層(layer)対応

`pathfinding.ts` / `reservation.ts` / `simulation.ts` / `trackPath.ts` を層対応させた
(`trackPath.ts`はOVERPASS_HEIGHT/rampHeightAtPos等が元々layer非依存の高さ計算式のため無改修)。

### Decision

- **到着判定は必ず`stationIdAtLayer(cell, layer)`を経由する**(`pathfinding.ts`でexport)。
  `layer===0`なら`cell.stationId`、`layer===1`なら`cell.upper?.stationId`。
  素の`cell.stationId===targetId`比較は、地平駅の真上をただの橋桁(`upper`はあるが
  `stationId`無し)で通過するだけの列車を「到着した」と誤判定するバグの原因だった
  (`pathfinding.ts`のBFS到着判定と、`simulation.ts`の「経路探索の結果が空だった→
  既に目的駅にいる」判定の両方に同種のバグがあった)。
- **ホーム延長(`findNextInLine`/`extendThroughPlatform`)にlayer引数を追加**し、
  地平専用だった実装を「layerに応じて`connections`か`upper.connections`を辿り、
  `stationIdAtLayer`で一致判定する」形へ一般化した(地平・高架でロジックを複製しない)。
- **`isSafeWaitingPoint`をlayerで分岐**: 高架側(`cell.layer===1`)は
  `upper.stationId`がある(高架ホーム)場合のみ待機可能、無ければ(単なる橋桁)不可。
  地平側は従来通り(`upper`を持つセル上では待機不可、ただし判定対象はあくまで
  地平connections)。分岐点判定(`isJunction`)もlayerに応じて
  `connections`/`upper.connections`を切り替えるよう一般化した。
- **`reservePlatform`/`releasePlatformExcept`は無改修で層別分離が成立する**。
  `StationData.cells`の各要素が`layer?`を持ち、`reservationKey`が`layer===1`で
  `"x,z:u"`という別キーを作るため、これらの関数が`station.cells`を素通しで
  `reservationKey`に渡す既存実装のままで、地平ホームと高架ホームの予約が
  自然に別資源になる。統合テストで実際に2列車が交点セルを同時保有できることを確認済み。
- **`RouteQuery.start`にlayerを追加(`{x,z,layer?}`)**。`calculateRouteWithStop`は
  `prevGrid`が無いとき常に地平(0)を既定にしていたが、これだと
  「高架駅ホームで停車→発車」のケースで発車経路が見つからなくなる
  (`stopAtStation`が停車確定時に`rt.prevGrid`を`null`にリセットするため、
  発車時の経路探索は`prevGrid`無しで呼ばれる。地平connectionsを持たない
  高架専用セルから発車しようとすると、layerを常に0とみなして探索し、
  移動不能になっていた)。`start.layer`を既定層のフォールバックにすることで解決。
  既存呼び出し側(`simulation.ts`)は`start: rt.grid`をそのまま渡しているため、
  `rt.grid.layer`が自然に伝播し、他の呼び出し(地平専用の既存テスト)には影響しない。
- **停車中の高さ**: `stopAtStation`が`renderPos.y`/`renderTarget.y`を`0.5`固定に
  していたため、高架ホームに停車した瞬間だけ列車が地平の高さへ沈む見た目になって
  いた。走行中と同じ`cellCentreHeight(railMap, x, z, layer)`を使うよう修正した。

### 統合テスト

`simulation.test.ts`に、建設APIに依存せずrailMap/stationsを直接組み立てたフィクスチャで
「地平を東西に走る列車」と「高架を南北に走る列車」が同じ駅id(`stX`、十字の交点セル)に
停車し、旅客が`stX`で乗り換えて反対側の駅まで運ばれることを確認する統合テストを追加した。
このテストの実装過程で、上記の「発車時のlayer既定値」バグを発見した。

### Constraints / Gotchas

- 高架専用セル(地平`connections`を持たない)に列車を"直接"配置してテストする場合、
  `prevGrid`が無いと`resolveEntryLayer`は解決不能({@link resolveEntryLayer}は
  `from`セルからの進入ビットでしか層を決められない)。テストでは、隣接する
  高架セル同士で自然に両方向のビットが立つ「経路の途中セル」を起点に選ぶか、
  `RouteQuery.start.layer`(今回追加)を明示するとよい。
- `passengers.ts`のサービスグラフは駅id単位で辺を張るため、乗換の実装自体は
  無改修で成立した(1駅idに地平・高架の両ホームがぶら下がっていれば、
  物理的にどちらのホームで乗降しても同じ駅idの待ち行列/降車として扱われる)。

## 追記(2026-07-28 free-elevated-track)
buildOverpassCore/applyElevatedStationの実装は`applyBridge`→`applyElevatedPath`への作り替え(`progress/free-elevated-track.md`)で置き換えられた。データモデル(upper/ramp/StationData.cells[].layer)自体は変更していない。
