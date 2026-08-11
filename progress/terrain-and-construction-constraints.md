# 地形(水域・山岳)による建設制約

フェーズ2最終要素。マップに湖と山岳を決定的に生成し、線路コスト・駅/車庫/信号の設置可否・街の立地に地形を反映した。

## 地形生成 (`src/sim/terrain.ts`)

- `generateTerrain(rng)`: towns.ts と同じ `mulberry32` 系のシード付き rng を受け取り、`Map<string, TerrainType>` を返す純粋関数。
  - 湖(`water`) 3〜5個: ランダムな中心からのランダムウォークで20〜60ステップ塗る(実際に登録されるセル数は自己交差で縮むことがある)。
  - 山脈(`mountain`) 2〜3本: ランダムな始点から角度を毎ステップ揺らしつつ15〜40セル伸ばし、進行方向に垂直な1〜2セル幅で塗る。
  - 生成範囲は `-45..45`。水域と山岳が重なった場合は後勝ち(山脈を湖より後に処理することで担保)。
- `terrainAt(terrain, x, z)`: 未登録セルは既定値 `'grass'` を返す。`x,z` は丸めてから参照するため呼び出し側で厳密な整数でなくても安全。
- 座標キーは utils.ts の `toKey`/`fromKey` (`"x,z"` 文字列)を流用しており、railMap などと同じ Map ベースの持ち方に揃えている。

## 建設制約

- `src/sim/construction.ts`
  - `applyStation` / `applyDepot` / `applySignal` は `terrain` 引数(既定値: 空Map = 全て平地)を追加。対象セルが `terrainAt !== 'grass'` の場合は **no-op**(既存の「同一参照を返せば課金しない」という仕組みにそのまま乗る。`useGameLogic.commitPath` 側の変更は不要)。
  - `applyRailPath` も `terrain` 引数を追加。線路自体は水域・山岳にも敷設可能で、該当セルに `bridge: true` / `tunnel: true` フラグを立てる(描画用。`CellData` に追加)。
- `src/sim/economy.ts`
  - `BRIDGE_COST_MULTIPLIER = 5`, `TUNNEL_COST_MULTIPLIER = 8` を追加。
  - `costOfPath(mode, cellCount, path?, terrain?)`: `path` と `terrain` を渡すとセルごとに地形を見て `RAIL_COST × 倍率` を合算する。省略時は従来通り `cellCount × RAIL_COST`(既存呼び出し・既存テストと完全互換)。
- `src/hooks/useGameLogic.ts`
  - `terrain` state を追加。新規ゲームでは `generateTerrain(mulberry32(worldSeed))` で生成し、`worldSeed` は towns 生成のシード(`worldSeed + 1`)と共有することで地形→街の順に決定的に生成する。
  - `generateTowns` に `terrain` を渡し、水域・山岳セルの半径3タイル以内を避けて街を配置する(`src/sim/towns.ts` の `isNearTerrain`)。
  - `commitPath` の rail 分岐で `costOfPath('rail', path.length, path, terrain)` を使い、station/depot/signal 分岐にも `terrain` を渡す。
  - `worldRef.current.terrain` を state と同期(`SimWorld.terrain` は任意項目。旧セーブ相当の呼び出しでも壊れないよう optional)。

## 描画

- `src/components/TerrainBlocks.tsx` 新規: water は半透明の青い平面タイル(y≈0.02)、mountain はグレーの四角錐(`coneGeometry`)。セル単位の素朴な mesh 描画(数百セル規模を想定、instancedMesh 化はしていない)。
- トンネル化された山岳セル(rail 敷設済みで `tunnel: true`)は `TerrainBlocks` 側で山の四角錐を描かず、`GameScene` 側でその位置に暗いグレーの薄い box を重ねて「坑口風」に見せる(シンプル優先)。
- 橋(`bridge: true`)の線路セルは `GameScene` 側でレールの下に薄い茶色の box を重ねて桁を表現する。

## persistence

- `SaveDataV5` を追加(`terrain: [string, TerrainType][]`)。`serialiseWorld`/`deserialiseWorld` の引数・返り値を拡張。
- 移行チェーン: v4以前のセーブには `terrain` が存在しないため、読み込み時は `terrain: new Map()`(全て平地)で補う。v1→v5 まで通しで動作することをテストで確認済み。

## 注意点・既知の制約

- `getConstrainedPath` は8方向(直線・斜め)にしか対応していないため、地形の形状次第では意図した通りに水域/山岳をまたぐ経路を引きにくい場合がある(既存仕様のまま)。
- 地形生成はランダムウォーク+幅塗りの簡易実装であり、湖や山脈の「セル数」は仕様のレンジ(20〜60 / 15〜40×幅1〜2)を上回ることはないが、自己交差により下回ることがある。テストでは上限のみ厳密にチェックし、下限は「0より大きい」程度の緩いsanityチェックに留めている。
- ブラウザでの手動検証(Browser ツール)では、クリック/hover座標の変換に必要な「world座標 → screen座標」のアフィン変換を実測で導出した: `screenX ≈ 355 + 15*(x - z)`, `screenY ≈ 234.5 + 8.5*(x + z)`(click-space、カメラ初期状態・zoom=40のとき)。今後同様の地形境界を狙ったクリック検証をする際に再利用できる。
