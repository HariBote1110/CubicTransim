# v0.2.0-Alpha-2a: OpenTTD Realistic流の物理加速モデルと停車処理のOpenTTD化

`progress/openttd-source-notes.md` のC節(速度・加減速)・B節(停車処理)を教科書として、
1セル=1タイル・stepWorld(dt)の世界に読み替えて実装した。GPLコードはコピーせず、
「力→加速度=F/m」の構造と、OpenTTD特有のヒューリスティック(1/10減衰・25×距離クランプ・
FarEnd固定)だけを再実装している。

## 1. 物理加速モデル (`src/sim/physics.ts`)

- `computeAcceleration(input, mode, fallbackDecelKmhS)`: OpenTTD `GroundVehicle::GetAcceleration()`
  の構造を再実装。牽引力(発進直後は粘着限界=maxTractiveEffortでクランプ、高速域はF=P/v)から
  転がり抵抗(質量に比例)・空気抵抗(速度の2乗に比例、連結数に比例)を差し引いた正味力を
  質量で割って加速度を出す。乗客数に応じて質量が増えるため、満載時は加速が鈍る。
  - ブレーキ側(`mode: 'braking'`)は既存のDECEL_KMH_S固定値をそのまま踏襲(OpenTTD同様、
    ノートC-3の「Original準拠の方が実装が楽」の判断を踏まえ、減速はシンプルに保った)。
- `applyOverspeedDecay(currentKmh, targetKmh, dt)`: OpenTTD `DoUpdateSpeed`の
  「最高速度超過時は瞬時にクランプせず現在速度の1/10ずつ緩やかに落とす」挙動を再現。
  1/30秒(OpenTTDの1tick相当)刻みで`v -= v/10`を繰り返す。
- 車種テーブル`TRAIN_SPECS`(`commuter`/`express`)を定数として持つ。TrainDataには
  車種フィールドを追加していない(将来の車種差別化に向けた設計だけ用意し、現状は
  全列車が`commuter`諸元を使う)。
  - `commuter`: enginePower=1200kW, carMassEmpty=30t/両, maxTractiveEffort=260kN
  - `express`: enginePower=2000kW, carMassEmpty=34t/両, maxTractiveEffort=320kN
  - 諸元は「空車2両編成・最高100km/h、発進直後の加速度が旧ACCEL_KMH_S=15km/h/s相当」を
    概ね維持するように調整した実測値(理論値ではなくゲーム感で決定)。

### stepWorldへの結線 (`src/sim/simulation.ts`)

- 加速: `rt.speedKmh < targetSpeed` のとき`computeAcceleration`(cars, passengers, 現在速度)で
  加速度を求め、`targetSpeed`でクランプする。
- 最高速度超過(`rt.speedKmh > MAX_SPEED_KMH`)時は瞬時クランプせず`applyOverspeedDecay`を使う。
- 減速(障害物・信号・駅接近)は従来通りDECEL_KMH_S固定で`targetSpeed`まで落とす
  (ノートC-3の判断通りOriginal準拠のシンプルさを維持)。

## 2. 駅停車処理のOpenTTD化

### 2-1. 停車位置 Near/Middle/Far (`src/sim/pathfinding.ts`)

`extendThroughPlatform`にOpenTTD `GetTrainStopLocation`相当の分岐を追加した:

1. **編成長(cars) >= ホーム長(P)なら、stopLocation設定によらず無条件でFarEnd(headIdx=P-1)固定**
2. それ以外は`stopLocation`(`'near'|'middle'|'far'`)に従う
   - `near`: `headIdx = min(cars,P) - 1` (編成ができるだけホーム内に収まる最小前進)
   - `middle`: `headIdx = ceil((P+cars)/2) - 1` (既存の編成中央基準、そのまま流用)
   - `far`: `headIdx = P - 1` (ホーム奥端)

headIdxは上記のいずれの分岐でも常に`P-1`以下になるため、旧実装にあった
「ホームの先の線路まで延長し、線路が尽きたらクランプする」ロジックは到達不能コードになり削除した。
これは意図的な仕様変更で、OpenTTDのFarEndも「ホーム奥端で止まる」のであって
それより先の線路へ出て行くわけではないため、方向性としては忠実化にあたる。
→ 既存のpathfinding.test.tsのうち、cars>=Pでホームの先へ延長していた2件の期待値を
FarEnd固定の新挙動(延長しない)に更新した。

`SimWorld.stopLocation`(`'near'|'middle'|'far'`、既定`'middle'`)をゲーム全体設定として持ち、
`calculateRoute`呼び出し2箇所(通常経路探索・終端反転後の再探索)に配線した。

### 2-2. 駅接近時の速度クランプ (`src/sim/simulation.ts`)

ノートB節の式をそのまま移植:

```
distanceToGoCells = 残り距離(m) / TILE_LENGTH
deltaV = 現在速度 / (distanceToGoCells + 1)
stMaxSpeed = max(25 × distanceToGoCells, 現在速度 − deltaV/10)
targetSpeed = min(既存のsqrt(2ad)カーブ, stMaxSpeed)
```

既存のsqrt(2ad)許容速度カーブと併用し、より慎重な方(小さい方)を採用する。
残り1セル未満では25km/h以下にクランプされ、OpenTTD特有の「駅へゆっくり滑り込む」挙動になる。
この仕様変更で駅間が極端に短い(1〜2セル)ケースの走破時間が従来より伸びるため、
`depot-station.test.ts`のtick予算とbreak条件、`simulation.test.ts`の
「速度が10km/h未満である時間」の上限を見直した(3秒→10秒。意図的な仕様変更であり、
新しい上限値は実測値をもとに設定)。

## 3. SaveData v8

`stopLocation`を追加してversion 8へ移行。v7以前は`stopLocation: 'middle'`で補う。

## 4. テスト・ブラウザ検証

- 新規: `src/sim/physics.test.ts`(6件)、pathfindingのstopLocation関連(4件)、
  persistenceのv7→v8移行(1件)、simulationの物理加速結線確認(2件)
- 既存テストの調整: depot-station.test.ts(FarEnd固定化に伴う停止セル変更・tick予算の見直し)、
  simulation.test.ts(加速テストを物理モデル前提に更新、駅接近クランプに伴う低速区間許容時間の見直し)、
  pathfinding.test.ts(cars>=Pでの延長ロジック削除に伴う期待値更新)
- 全193→194件、`npm run test`全パス、`npm run build`成功
- ブラウザ検証(`__dbgStep`によるtick注入): railMap/stations/trainsを直接注入し、並走2線に
  空車2両編成(tEmpty)と満載2両編成(passengers=200注入、tFull)を配置して10秒(100tick)進めた。
  結果: tEmptyはx=4・69.2km/h、tFullはx=3・61.2km/h となり、乗客による質量増加で加速が
  鈍ることを確認(F/m構造が効いている)。UI右上のNear/Middle/Farトグルをクリックし、
  `worldRef.current.stopLocation`が'middle'→'near'に切り替わることを確認(SimWorldへの
  React state配線が機能している)。
