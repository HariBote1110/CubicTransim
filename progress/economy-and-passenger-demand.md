# 経済システムと旅客需要（フェーズ2中核）

## Decision

- **経済定数は `src/sim/economy.ts` に集約**。`STARTING_MONEY` / `RAIL_COST` / `STATION_COST` / `DEPOT_COST` / `SIGNAL_COST` / `TRAIN_COST` / `PASSENGER_SPAWN_RATE` / `STATION_WAITING_CAP` / `TRAIN_CAPACITY` / `FARE_PER_TILE` の10定数と、`costOfPath(mode, cellCount)` のみを持つ純粋モジュール。UI/hooksからはここだけを参照する。
  - `costOfPath('rail', cellCount)` は `cellCount × RAIL_COST`。station/depot/signalは単セル操作前提のため`cellCount`を無視した単価固定。
- **所持金 (`money`) は `useGameLogic` のReact state**。`worldRef.current.economyMirror = { money }` として毎レンダー後にsim world側へも鏡写しし、`__debugWorld.economyMirror` からブラウザ検証できるようにした（sim層のロジックはこの値を一切参照しない、純粋なデバッグ用ミラー）。
- **建設コストの課金は `useGameLogic.commitPath` に集約**。`costOfPath`で見積もり→`money`不足なら建設関数を呼ばず即return→construction.tsの`apply*`実行→戻り値の`railMap`/`stations`が**参照として変化していなければno-opとみなし課金しない**。
  - station/depot/signalの`apply*`は「上書き防止」等で早期returnする際に**同一オブジェクト参照**を返す既存実装を利用しているため、この判定がそのまま機能する。
  - rail(`applyRailPath`)は変化の有無に関わらず常に`new Map(...)`を返すため、この判定では「本当に無変化かどうか」は区別できない。**1点だけのクリック(`path.length===1`)でもRAIL_COST分課金される**のは把握済みの制約（既存駅ワープ済みセルの二重クリック等）。実害は小さいため今回は許容し、ここに明記するに留めた。
- **列車購入 (`buyTrain`)** も同様に `money < TRAIN_COST` なら早期return。
- **旅客需要はsim層(`stepWorld`)が所有**。`SimWorld.waiting: Map<stationId, number>` を毎tick `PASSENGER_SPAWN_RATE × dt` だけ増やし `STATION_WAITING_CAP` で頭打ち。runtimes同様、Reactからは触らずインスタンスを保持し続ける。
- **乗降・運賃収入もsim層で完結**。列車が駅に停車する瞬間（`stopRemaining`をセットする箇所）に:
  1. 降車: `passengers>0 && lastStopStationId`があれば直前駅center↔今回駅centerのユークリッド距離(タイル)×`FARE_PER_TILE`×人数を`SimEvent{type:'income'}`として発行し`passengers=0`。
  2. 乗車: `waiting`から`min(waiting, TRAIN_CAPACITY)`人を乗せ`waiting`を減算。
  3. `lastStopStationId`を更新。
  - `useGameLogic`は`'income'`イベントを受けて`addIncome(amount)`で`money`に加算するだけ。
- **セーブデータをv2化**。`money`・`waiting`・`TrainRuntime.passengers`/`lastStopStationId`を追加。`version`を2に上げ、v1データ読み込み時は`waiting`空Map・`money=STARTING_MONEY`・各runtimeの新フィールドを既定値で補う後方互換処理を`deserialiseWorld`に実装。

## Alternatives considered

- 課金判定を「変更前後のMapサイズ比較」等の内容比較にする案 → construction.tsの既存no-op実装（同一参照return）を活かす方が変更範囲が小さく、station/depot/signalには完全に効くため採用。railの精度不足は既知の制約として明記するに留めた。
- 待ち人数表示をGameScene側で一括ポーリングしstateに持つ案 → StationLabel自身が`useFrame`で低頻度(0.5秒間隔)にpollする方が既存のDynamicTrainの速度表示パターンと一貫しており実装も単純なため採用。
- 乗客数表示をCanvas内Html要素で作る案 → GameUIはCanvas外のDOMパネルのため、`setInterval`による低頻度ポーリング(500ms)で`world.current.runtimes`を読む方式にした。

## Constraints / Gotchas

- 単一クリック(ドラッグなしの点)でのrail建設は、対象セルが既存rail/station/depotのいずれであっても`RAIL_COST`分課金される（no-op判定がrailには効かないため）。実害は小さいが将来直すなら`applyRailPath`にも「変化なしなら同一参照を返す」実装を入れる必要がある。
- `waiting`・`runtimes`はsim所有のミュータブルMapなので、セーブ/ロード時は**Mapインスタンスを維持したまま`clear()`→`set()`で中身だけ入れ替える**（`clock-and-persistence.md`のruntimes運用と同じ理由）。
- ブラウザ検証で`__dbgStep`を使う場合、`income`イベントによる`money`更新も他のReact state更新と同様に**同一`javascript_exec`呼び出し内では反映されない**（バッチング）。次の`javascript_exec`呼び出しで`economyMirror`を読むと反映されている。
