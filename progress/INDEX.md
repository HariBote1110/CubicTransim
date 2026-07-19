# progress インデックス

- [terrain-and-construction-constraints.md](terrain-and-construction-constraints.md) — 地形(水域・山岳)の決定的生成(generateTerrain/terrainAt)、駅・車庫・信号の水域/山岳no-op、線路の橋(5倍)/トンネル(8倍)コスト、街生成の地形除外、SaveData v5移行、地形描画(TerrainBlocks)とworld座標→screen座標のアフィン変換(ブラウザ検証用)
- [economy-and-passenger-demand.md](economy-and-passenger-demand.md) — 所持金/建設コスト/列車購入の課金ロジック(no-op判定の使い方と限界)、旅客需要(waiting)・乗降・運賃収入(income)のsim層実装、セーブデータv2移行
- [construction-layer-and-bugfixes.md](construction-layer-and-bugfixes.md) — 建設ロジックを sim/construction.ts へ純粋関数化し、既知バグ5件（上書き防止・斜め線路駅・駅名採番・モード切替直後クリック）をTDDで修正
- [clock-and-persistence.md](clock-and-persistence.md) — ゲーム内時計(0/1/2/4x)とlocalStorageセーブ/ロードの設計。runtimes Mapはインスタンス維持で入れ替えること
- [sim-layer-extraction.md](sim-layer-extraction.md) — 走行ロジックを純粋なsim層(stepWorld)へ分離した経緯と、非表示タブのrAF停止・既知バグ一覧などの注意点
- [accidents-and-platform-doors.md](accidents-and-platform-doors.md) — 人身事故(rng注入で決定的にテスト)とホームドアの設計、駅選択UI(列車選択と排他)、SaveData v3移行、Browserツールでの建設操作の注意点(単発clickでは反応しない場合がある等)
- [towns-and-location-based-demand.md](towns-and-location-based-demand.md) — 街(town)の決定的生成(mulberry32/generateTowns)、駅の立地需要係数demandFactor、stepWorldの旅客湧き率を立地需要ベースに変更、街の描画(TownBlocks)とUIへのDemand表示、SaveData v4移行
