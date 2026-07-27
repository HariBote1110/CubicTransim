# 十字の乗り換え駅(シミュレーション層)

## Decision
- `applyStation`(construction.ts)の「既存セルが station/depot なら拒否」を分割し、depotは従来通り拒否、stationは拒否せず交差を許可するようにした。
- 駅セルは新規設置時から常に `DIR.N|E|S|W` の全方向connectionsを持つ(既存仕様)。そのため十字駅の交差セル自体は接続ビットのマージ処理が不要で、「どの駅IDに属させるか」の決定と、複数の駅が絡む場合の統合だけが新たに必要な仕事だった。
- 統合ロジック: pos自身が既に駅セルの場合の駅ID(`crossingStationId`)と、隣接4セルにある駅IDを集めて重複排除した `involvedIds` を作る。
  - 0件 → 新規駅を作成。
  - 1件 → 従来通りその駅へ延伸(セルを追加)。
  - 2件以上 → 十字駅として統合。`state.stations` の挿入順(Mapは挿入順を保持する)で最も早いIDを残し、他のIDのcellsを吸収・railMap上の該当セルのstationIdを付け替え、削除したIDをstationsから消す。中心セル(pos)自身も統合後のcellsに追加する。
  - 「crossingStationId はあるが involvedIds が1件以下」の場合のみ、旧来通りの完全no-op(参照を変えない)を維持し、`buildPreview.ts` の `result.railMap !== state.railMap` によるno-effect判定を壊さないようにした。
- 実際には、1セル幅の十字(腕の長さがどれだけ長くても中心は1セル)の場合、交差点そのものへ到達する1手前で必ずどちらかの駅の隣接セルになるため、統合は「中心セルに直接乗り上げる瞬間」ではなく「隣接した瞬間」に起きることが多い。これは意図した挙動で、どちらの経路で統合が起きても最終結果(1つの駅、正しいcells/center)は同じになる。
- pathfinding.ts / reservation.ts / trackPath.ts は無改修。駅セルの方向はconnectionsビット任せの汎用ロジックであり、4方向とも既に扱える設計だったため、十字駅は「駅データ構造の統合」だけで成立した。予約(reservation.ts)はセル単位のため、交差セルは自動的に単一の排他資源になり、南北・東西の列車が同時に入れないことをテストで確認した。

## Alternatives considered
- 交差セルに「軸ごとの予約資源」を分ける案(橋のupperのように層を分ける)は、駅の交差はダイヤモンドクロッシングと違って同一平面上で「同じ駅」として扱いたいだけなので不要と判断し、採用しなかった。

## Constraints / Gotchas
- 統合の「先に存在した駅」の判定は、正確な作成時刻ではなく `stations` Map の挿入順(JSのMapは挿入順を保持する)で代用している。セーブ/ロード後もMapの構築順(persistence.tsのdeserialiseWorldでのMap生成順)が保たれる前提。
- テンプレート適用(stationTemplates.ts、要件2)では、テンプレート内の複数セルを`applyStation`で1セルずつ適用する実装のため、上記の統合ロジックがそのまま働く(二重に判定ロジックを書いていない)。

## 駅テンプレート(stationTemplates.ts)
- `StationTemplate = { id, name, description, cells: { dx, dz, kind: 'station'|'rail' }[] }`。座標はアンカー(設置基準セル)からの相対値。
- `rotateTemplate(template, quarterTurns)`: 時計回り90度刻みの純粋な回転。東(1,0)→(90度)→南(0,1)。`-0`がtoEqual比較やセルキー生成で紛れ込むため、回転後の値は`normalizeZero`で+0に正規化している。
- `STATION_TEMPLATES`: `'cross'`(十字乗換駅、東西・南北それぞれ長さ5の駅セル列が中心(0,0)で交差、合計9セル)と `'through'`(相対式2面2線、平行な長さ4の駅セル列2本をdz=0,1の隣接する形で配置、合計8セル)。throughは2本が直接隣接しているため、設置すると要件1の交差統合ロジックにより自動的に1つの駅になる。
- `applyStationTemplate(state, anchor, template, quarterTurns, towns, terrain)`: 判定を二重に書かないため、実際に`applyStation`/`applyRailPath`を1セルずつ適用してみて、駅セルなら`railMap.get(key)?.type === 'station'`になっているかを確認する方式(evaluateBuild.tsと同じ考え方)。1つでも設置できなければ(地形制約・車庫との衝突など)、元のstateをそのまま返す(all-or-nothing)。rail種別のセルは、テンプレート内で8方向隣接する他のセルへ`applyRailPath`で接続する(現時点の2テンプレートはstationのみで未使用だが、将来のテンプレート用に汎用実装している)。
- `buildPreview.ts` に `evaluateStationTemplate(template, anchor, quarterTurns, railMap, stations, terrain, money, towns)` を追加。コストは駅セル数×STATION_COST + 線路セル数×RAIL_COST。可否判定はevaluateBuildと同じ「実際に適用してみて参照が変わるか」方式。
- CellData/StationDataの型は変更していないため、SaveDataのバージョンは上げていない(persistence.tsは無改修)。
