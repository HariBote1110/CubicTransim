# 人身事故とホームドア(フェーズ3)

## ゲームデザイン

駅に旅客が溢れると人身事故(抽象的な運行イベントとして扱う。生々しい描写はしない)が
発生し、該当列車が一定時間運転を見合わせる。ホームドアを設置すると事故率が下がる。
表現は「Service suspended (accident)」「⚠ Station X で人身事故が発生 —
運転見合わせ中」のように運行情報の体裁に留めている。

## データモデル

- `StationData.platformDoors: 'none' | 'standard' | 'fullscreen'`(既定 `'none'`)
- `TrainRuntime.haltRemaining: number`(既定 0。事故発生時に
  `ACCIDENT_HALT_DURATION`(60秒)がセットされ、`stepWorld`のdtずつ減る)
- `SimWorld.rng: () => number`(本番は`Math.random`、テストは固定値関数を注入して
  決定的に検証する)
- `economy.ts`定数: `PLATFORM_DOOR_STANDARD_COST`(3,000)、
  `PLATFORM_DOOR_FULLSCREEN_COST`(8,000)、`ACCIDENT_BASE_CHANCE`(0.01)、
  `ACCIDENT_DOOR_MODIFIER`(none=1.0 / standard=0.05 / fullscreen=0)、
  `ACCIDENT_HALT_DURATION`(60)、`ACCIDENT_PENALTY`(5,000)
- `calculateAccidentChance(doorType, waiting)` = 基本確率 × ドア係数 ×
  (0.5 + waiting / STATION_WAITING_CAP)。waiting=0で0.5倍、waiting=CAPで1.5倍。

## シミュレーション(simulation.ts)

列車が駅に停車する瞬間、乗降処理の**後**(降車・乗車が終わった時点でのwaitingCount、
乗車前の値)を混雑度として事故判定を行う。`world.rng() < 事故確率`なら:

- `haltRemaining = ACCIDENT_HALT_DURATION` をセット
- `SimEvent { type: 'accident', trainId, stationId, penalty: ACCIDENT_PENALTY }` を発行

`stepTrain`内の優先順位は **halt → stop → 発車**。`haltRemaining > 0`の間は
速度0で完全停止し、debugStatusを`'Service suspended (accident)'`にする。
haltRemainingが尽きてから通常の`stopRemaining`(STOP_DURATION)消化に入るため、
実質的な停車時間は「60秒 + 通常の停車時間」になる。停車中のセル占有は既存の閉塞
ロジックがそのまま働くので、後続列車の詰まりは追加実装なしで自然に発生する。

## UI

- `useGameLogic`に`selectedStationId`を追加。列車選択とは排他(どちらかを選ぶと
  他方が解除される)。`GameScene`のクリックハンドラで「列車未選択かつスケジュール
  編集中でない」場合のみ駅セルクリックで駅を選択する。
- `GameUI`の左上パネルに、列車未選択・駅選択中は駅パネル(駅名・待ち人数・現在の
  ドア種別・アップグレードボタン2つ)を表示する。ダウングレード不可、
  fullscreen導入済みならstandardボタンも無効化する。
- 事故通知は`useGameLogic`内の`activeAccidents`配列で管理し、500ms間隔の
  `setInterval`で該当列車の`haltRemaining`が尽きたエントリを自動的に取り除く
  (StationLabelの待ち人数ポーリングと同じパターン)。画面上部に赤いバナーで表示する。
- `StationLabel`に`▣`(standard)/`◼`(fullscreen)の印を駅名の横に表示する。

## persistence

`SaveData`を`v3`に更新。`platformDoors`と`haltRemaining`を含めてシリアライズする。
v1/v2データのロード時は`platformDoors ?? 'none'`・`haltRemaining ?? 0`で安全に
補う(v1→v3も既存の移行チェーンでそのまま動く)。

## ブラウザ検証で分かったこと(エージェント向け追記)

- Canvas上の建設/選択操作は`onPointerDown`/`onPointerUp`で処理されるため、
  Browserツールの`computer`アクションでは**単発の`left_click`では反応しない**
  ことがある。同一座標への`left_click_drag`(start===end)を使うと
  pointerdown→pointerup が確実に発火し、建設・選択が成立した。
- `read_page`が返す座標系(1280x720)と`screenshot`/`click`が使う座標系(800x450)
  は異なる。ボタンなどのDOM要素は`read_page`で取得した`ref`を使って
  `computer{action:"left_click", ref}`で押すのが確実。
- 車庫で列車を購入すると自動的に選択される(`buyTrain`)が、`stored`状態の列車は
  `DynamicTrain`が`null`を返すため3D上に表示されず、一度選択解除すると
  クリックで再選択できない。検証時は`window.__debugWorld.trains[...]`を直接
  書き換えてschedule/statusを設定するのが手早い(stepWorldは`worldRef.current`
  を直接見るため、React state経由でなくても動作検証はできる)。
