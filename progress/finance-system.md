# 財政システムの完成(0.1.0-Alpha-6a)

## 概要
ゲーム内の暦(年/月/日)と月次決算を実装し、プレイヤーが「何で稼ぎ、何に使ったか」を収支パネル(Finance)で把握できるようにした。ライト仕様(借金・倒産なし。残高マイナスは赤字表示のみ)。

## sim層(clock/monthEnd)
- `src/sim/economy.ts` に `SECONDS_PER_DAY = 10`(シミュレーション秒)・`DAYS_PER_MONTH = 30` を追加。
- `clockToDate(elapsed)` で 1年1月1日開始・12ヶ月/年の年月日を導出する純粋関数を実装。
- `monthIndexOf(elapsed)` / `yearMonthOfIndex(index)` は月跨ぎ検出用の内部ヘルパー(絶対月インデックス⇔年月の相互変換)。
- `SimWorld.clock: { elapsed: number }` を追加(旧セーブとの互換のためoptional)。
- `stepWorld` は毎tickで `clock.elapsed += dt` した後、月インデックスが変化した分だけ `SimEvent { type: 'monthEnd', year, month }` を発行する。大きいdtで複数月またいだ場合は月数分発行する(終わった月の年月を1つずつ)。

## 維持費(calculateUpkeep)
- 定数: `TRAIN_UPKEEP = 500`(/編成/月)・`RAIL_UPKEEP = 2`(/セル/月。橋・トンネルも同額)・`STATION_UPKEEP = 100`(/駅/月)・`DEPOT_UPKEEP = 100`(/棟/月)。
- `calculateUpkeep(world)`: `railMap` を走査し `type==='rail'` のセル数と `type==='depot'` のセル数を数え、`trains.length`・`stations.size` と合わせて合計を返す純粋関数。

## React側(useGameLogic)
- `MonthlyLedger { year, month, fares, construction, upkeep, accidents }` を `economy.ts` に定義(persistenceからも参照するため)。
- `currentLedger`(進行中の月)と `ledgerHistory`(直近12ヶ月、確定順)をstateとして保持。
- `addIncome` で fares 加算、`commitPath`/`buyTrain` の課金時に construction 加算、`handleAccident` で accidents 加算。
- `handleMonthEnd(event)`: `calculateUpkeep(worldRef.current)` を money から差し引き、currentLedgerを確定させて(year/month/upkeepを反映)履歴末尾へpush(直近12件にslice)、次の月(year/month繰り上げ込み)の空台帳を新規作成する。
- money はマイナスを許容する(建設・列車購入のみ、従来通り残高不足ならブロック)。

## UI(GameUI.tsx)
- 上部バーに `{year}年 {month}月 {day}日` を表示。sim層のclockは他の値(passengers/waiting)と同様、低頻度ポーリング(500ms)でReact stateへ反映する。
- 所持金表示はマイナス時に赤(`#cc0000`)、通常は緑(`#00994d`)。共通の `formatSigned` で3桁区切り＋符号付き表示にした。
- `Finance` ボタン(上部バー)で収支パネルをトグル。今月の途中経過(進行中)行と、確定済み履歴(新しい順)をシンプルなHTMLテーブルで表示。損益列はプラス緑・マイナス赤。

## persistence v6
- `SaveDataV6` に `clock: { elapsed }` / `currentLedger` / `ledgerHistory` を追加。
- v5以前からの移行は `clock={elapsed:0}` ・ `currentLedger=emptyLedger()`(1年1月の空台帳) ・ `ledgerHistory=[]` で補う。v1→v6のチェーンが通ることをテストで確認。
- `emptyLedger()` を persistence.ts からエクスポートし、useGameLogicの初期stateにも流用。

## 既知の注意点
- 台帳の「進行中」行はReact側 currentLedger のスナップショットであり、sim層は毎tickでは更新しない(income/construction/accidentイベント発生時のみ加算)。維持費だけは月末に一括計算する。
- ブラウザでの月跨ぎ検証は `__dbgStep` を複数回の `javascript_exec` に分けて呼ぶ必要がある(monthEndイベント→React setStateのバッチングのため、同一呼び出し内では反映が遅れる)。
