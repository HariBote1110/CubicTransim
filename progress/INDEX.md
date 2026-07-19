# progress インデックス

- [consist-system-and-braking-curve.md](consist-system-and-braking-curve.md) — 編成(consist)システム(TrainData.cars、両数比例の定員/維持費/増結解結、ホーム長ペナルティ、車庫の編成エディタUI、DynamicTrainの複数車両描画)と、距離ベースの許容速度に変更した減速カーブの設計。SaveData v7移行
- [passing-loop-signalling.md](passing-loop-signalling.md) — 信号場での自動すれ違い(交換設備)。信号コンフリクト判定の見通し区間(lookahead)を固定10マスから「次の分岐点/信号セルの手前まで」に変更し、対向列車が分岐点に単に立ち寄っているだけの状態を衝突懸念とみなさないようにしてデッドロックを解消
- [terrain-and-construction-constraints.md](terrain-and-construction-constraints.md) — 地形(水域・山岳)の決定的生成(generateTerrain/terrainAt)、駅・車庫・信号の水域/山岳no-op、線路の橋(5倍)/トンネル(8倍)コスト、街生成の地形除外、SaveData v5移行、地形描画(TerrainBlocks)とworld座標→screen座標のアフィン変換(ブラウザ検証用)
- [economy-and-passenger-demand.md](economy-and-passenger-demand.md) — 所持金/建設コスト/列車購入の課金ロジック(no-op判定の使い方と限界)、旅客需要(waiting)・乗降・運賃収入(income)のsim層実装、セーブデータv2移行
- [construction-layer-and-bugfixes.md](construction-layer-and-bugfixes.md) — 建設ロジックを sim/construction.ts へ純粋関数化し、既知バグ5件（上書き防止・斜め線路駅・駅名採番・モード切替直後クリック）をTDDで修正
- [clock-and-persistence.md](clock-and-persistence.md) — ゲーム内時計(0/1/2/4x)とlocalStorageセーブ/ロードの設計。runtimes Mapはインスタンス維持で入れ替えること
- [sim-layer-extraction.md](sim-layer-extraction.md) — 走行ロジックを純粋なsim層(stepWorld)へ分離した経緯と、非表示タブのrAF停止・既知バグ一覧などの注意点
- [accidents-and-platform-doors.md](accidents-and-platform-doors.md) — 人身事故(rng注入で決定的にテスト)とホームドアの設計、駅選択UI(列車選択と排他)、SaveData v3移行、Browserツールでの建設操作の注意点(単発clickでは反応しない場合がある等)
- [towns-and-location-based-demand.md](towns-and-location-based-demand.md) — 街(town)の決定的生成(mulberry32/generateTowns)、駅の立地需要係数demandFactor、stepWorldの旅客湧き率を立地需要ベースに変更、街の描画(TownBlocks)とUIへのDemand表示、SaveData v4移行
- [finance-system.md](finance-system.md) — ゲーム内暦(clockToDate/monthEndイベント)と維持費(calculateUpkeep)、月次収支台帳(MonthlyLedger)のReact側管理とFinanceパネルUI、SaveData v6移行
- [alpha7b-bugfixes.md](alpha7b-bugfixes.md) — v0.1.0-Alpha-7bの5件の不具合修正: 乗客数の小数混入、線路描画(RailBlock)のセル境界点方式への作り直し、駅停車時のrenderTarget未更新による向きリセット、無信号複線でのBFSタイブレークによる左側通行化、信号(SignalBlock)の矢印表示刷新
- [alpha8b-consist-and-depot-station.md](alpha8b-consist-and-depot-station.md) — v0.1.0-Alpha-8b: 連結車両の描画をtrail(占有判定用)から独立したpathHistory(描画用、cars+2長)+弧長ベースのポリライン補間(sim/consist.ts の carPositions)に変更してカクつきを解消。車庫の真ん前に駅があり単独駅スケジュールでscheduleIndexがループするケースで永久Waitingになるバグを発見・修正(stepTrainで「既に目的駅にいる」場合は即到着処理)。DIR定数のビット値を使わないブラウザ検証スクリプトは経路探索が常に失敗する注意点も記録
- [alpha9a-platform-stop-and-instant-reversal.md](alpha9a-platform-stop-and-instant-reversal.md) — v0.1.0-Alpha-9a: calculateRouteが目的駅セルに到達したあと進行方向へホーム(同一stationIdの連続セル)奥端まで経路を延長し、先頭車基準ではなくホーム全体基準の停車位置にした。終端駅での折り返し発車時にtrail/pathHistoryを組み替えて編成を瞬時に反転させ、後続車が先頭車をすり抜けるように反転する見た目のバグを解消(pathHistoryは単純反転せずtrail反転+パディングで組み直し、car spacing破綻を回避)
