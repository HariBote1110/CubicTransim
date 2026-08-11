# 街(town)と立地ベースの旅客需要

## 背景

フェーズ2の残タスクとして、マップ上に人口を持つ街を自動生成し、駅の旅客湧き率を
「周辺の街の人口と距離」から決めるようにした。従来は全駅一律
`PASSENGER_SPAWN_RATE`(0.5人/秒)で待ち人数(waiting)が増えていたが、街から
離れた駅にはほぼ客が来ないようにするのが目的。

## 設計

### 街の生成 (`src/sim/towns.ts`)

- `mulberry32(seed)`: シード付き決定的疑似乱数生成器。テストの再現性のために
  導入した。同じシードから常に同じ乱数列が得られる。
- `generateTowns(rng, count = 8)`: 中心座標を `-40..40` の範囲で、rejection
  sampling により街同士を最低 `TOWN_MIN_DISTANCE`(12タイル)離して配置する。
  population は 500〜5000 の範囲でランダムに決まる。試行回数の上限
  (`MAX_ATTEMPTS_PER_TOWN`)を設けてあるが、範囲80×80・最低距離12タイルの
  組み合わせでは8個程度なら現実的にほぼ必ず配置しきれる。

### 立地需要 (`src/sim/economy.ts`)

- `TOWN_INFLUENCE_RADIUS = 10`(タイル)。駅への影響が届く最大距離。
- `demandFactor(stationCentre, towns)`: 各街について
  `(population / 1000) × max(0, 1 - distance / TOWN_INFLUENCE_RADIUS)` を計算し
  合算する。複数の街が範囲内にあれば加算される。距離が半径を超えると寄与0。
- `stepWorld`(simulation.ts)の旅客湧き率を
  `PASSENGER_SPAWN_RATE × demandFactor(station.center, world.towns) × dt`
  に変更した。`SimWorld.towns` は旧セーブとの互換のため任意(`towns?:
  TownData[]`)とし、未指定時は空配列(=旅客需要0)として扱う。

  シンプルさを優先し、demandFactorはキャッシュせず毎tick計算している(駅数×
  街数は小さいため無視できるコスト)。

### 描画 (`src/components/TownBlocks.tsx`)

- 各街を中心の大きめの建物1個 + 人口に応じて3〜10個の小さな建物群として表現。
  建物配置は街の id から `mulberry32` でシードした乱数で決定的に配置する
  (再レンダリングのたびに位置が変わらないよう `useMemo` で固定)。
- 人口ラベルは "2.3k" のような簡易表記(`formatPopulation`)。StationLabelと
  似た見た目の `Html` オーバーレイで表示。

### UI

- 駅パネル(GameUI.tsx)に `Demand: X.Xx` を追加。選択中駅のcentreと
  `world.current.towns` から `demandFactor` を計算し、waitingと同様500ms
  間隔でポーリング表示する。

### persistence: SaveData v4

- `towns: TownData[]` を追加した `SaveDataV4` を新設。
- v3以前のデータには towns が存在しないため、`towns: []`(街なし)で補って
  移行する。v1→v4の移行チェーンもテストで確認済み。

## 既知の注意点

- `useGameLogic` の街は「初回起動(セーブなしの新規状態)」でのみ
  `generateTowns(mulberry32(Date.now() % 2**31), 8)` により自動生成される
  (useState の初期化関数として実行)。ロードすると save data の towns で
  上書きされる。
- テストでは `simulation.test.ts` の `makeWorld` に `towns` 引数を追加し、
  街に依存する既存の待ち人数系テスト(旧・一律 `PASSENGER_SPAWN_RATE` 前提)は
  `townsAtStations` ヘルパーで駅の真上に街を置くことで
  `demandFactor` 前提の期待値に置き換えた。人身事故系のテストは
  congestion係数の範囲(0.5〜1.5倍)が街の有無によらず成立する設計だったため
  変更不要だった。

## ブラウザ検証

- `localStorage.clear()` 後にリロードし、街の建物群と人口ラベル(例:
  "4.6k", "4.9k")が表示されることを確認した。
- 街の近く(街の中心から1タイル)と遠く(最寄りの街まで12タイル以上)に駅を
  建て、`__dbgStep(1.0, 10)` で10秒進めたところ、近い駅の waiting は
  `PASSENGER_SPAWN_RATE × demandFactor × dt` の理論値通りに増加し、遠い駅は
  0のままであることを `__debugWorld.waiting` で確認した。
- 駅パネルに `Demand: 4.2x` のように立地需要係数が表示されることを確認した。
