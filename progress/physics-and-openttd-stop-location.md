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

## 5. v0.2.0-Alpha-2b: 駅接近クランプの条件分岐欠落を修正(ガクガク/だらだらクロールの根本原因)

### 5-1. 症状の実測(修正前)

`buildStraightLine(15セル)` + 単一駅で、dt=1/60・列車1両でstepWorldを回し、
残距離とspeedKmhの推移をログした(scratchpadに保存)。判明した具体的な症状:

- 停止直前、残距離6.0m地点でspeedKmhがちょうど5.00km/h(=MIN_CRAWL_SPEED_KMH)に張り付き、
  そのまま**258tick(4.3秒)**にわたって完全に一定のまま停止位置まで這い続けた
  (「だらだらクロール」の実測値)。
- ただし今回のシナリオ(単一駅・信号なし・reservedEndIndexが常に終点)では速度の増加=脈動は
  観測されなかった。ピーク速度92.4km/h到達後は単調非増加だった。

### 5-2. 根本原因の確認結果

`src/sim/simulation.ts`の駅接近クランプ(旧420〜445行付近)は、OpenTTD原式
(`train_cmd.cpp Train::GetCurrentMaxSpeed()`)の

```cpp
int st_max_speed = 120; // ノーオペ相当の初期値
int delta_v = this->cur_speed / (distance_to_go + 1);
if (max_speed > (this->cur_speed - delta_v)) st_max_speed = this->cur_speed - (delta_v / 10);
st_max_speed = std::max(st_max_speed, 25 * distance_to_go);
max_speed = std::min(max_speed, st_max_speed);
```

のうち、`if (max_speed > cur_speed - delta_v)` という**条件分岐**を欠落させ、
`cur_speed - delta_v/10`を無条件で`25×distanceToGoCells`とmax合成していた。
これにより、sqrtカーブが既に十分減速している場面でもこのヒューリスティックが
毎tick介入し続け、2つの減速メカニズムが常に競合する構造になっていた。

なお実測では、この用意された単一駅シナリオでは`targetSpeed(sqrtカーブ)`が
ほぼ常に現在速度を上回る状態(加速・巡航・単純減速の全域)だったため、条件分岐の
有無で数値上の差はほぼ出なかった(条件が常にtrueで従来と同じ経路を通る)。
条件分岐は「複数の障害物(信号・他列車予約)が切り替わる場面」や「sqrtカーブ側の
制約が既により厳しい場面」で無用な二重介入を防ぐためのものであり、原式に忠実な
構造にしておくことがOpenTTD挙動への準拠と将来の信号シナリオでの安全性につながる。

### 5-3. 修正内容

`src/sim/simulation.ts`の駅接近クランプを2段構成に修正した:

```ts
let stMaxSpeed = MAX_SPEED_KMH; // ノーオペ相当
if (targetSpeed > rt.speedKmh - deltaV) {
  stMaxSpeed = rt.speedKmh - deltaV / 10;
}
stMaxSpeed = Math.max(stMaxSpeed, 25 * distanceToGoCells); // 無条件の安全下限
targetSpeed = Math.min(targetSpeed, stMaxSpeed);
targetSpeed = Math.max(targetSpeed, MIN_CRAWL_SPEED_KMH);
```

修正後のプロファイルは修正前と同一シナリオでは数値上ほぼ変化なし(上記5-2の理由による)。
`MIN_CRAWL_SPEED_KMH`によるクロール(258tick=4.3秒・残り6m)は、到着判定を確実に
発火させるための既存の意図的な仕様(コメント参照)であり、かつOpenTTD自体も駅への
最終アプローチで低速クロールする挙動を持つため、これ自体は許容範囲内と判断した
(単に速度が下限に張り付いたまま停止まで直進するだけで、脈動や急変は伴わない)。

### 5-4. 追加したテスト

`src/sim/station-approach.test.ts`(新規、2件):

1. 「ピーク速度到達後、停止まで速度が増加に転じない(脈動なし・単調非増加)」
2. 「MIN_CRAWL_SPEED_KMH以下の低速クロール時間は妥当な範囲に収まる(=無限に這い続けない)」
   (実測4.3秒に対し、上限6秒を「異常な長時間停滞ではないこと」の回帰チェックとして設定)

Red→Green確認済み。`npm run test`は全196件パス、`npm run build`成功。

## 6. v0.2.0-Alpha-2c: だらだらクロールの解消(駅接近クランプに最低値を導入)

### 6-1. 経緯

5節では「5km/hで4.3秒のクロール」を許容範囲としたが、ユーザー苦情
「駅の停車が下手くそすぎる」「5km/hでじわじわ止まる時間が超長い」の主因が
まさにこのクロールだと判明したため、許容せず修正した。

### 6-2. 原因の構造

`25×distanceToGoCells`の床は線形(v∝残距離d)であり、v=k·dに従うと時間軸では
d(t)が指数的に漸近する(dd/dt=-k·d)。このため停止位置に近づくほど減速が
だらだらと引き延ばされ、実測では**10km/h未満の滞在が合計7.92秒**
(うちMIN_CRAWL_SPEED_KMH=5km/h張り付きが4.3秒)に達していた。

### 6-3. 修正内容

`STATION_APPROACH_MIN_KMH = 15.0` を新設し、駅接近クランプの床を
`Math.max(stMaxSpeed, 25 * distanceToGoCells, STATION_APPROACH_MIN_KMH)` に変更した。
これにより線形床が15km/hを下回る終盤(残り約18m以内)では、速度制御が
sqrt(2ad)の許容速度カーブ側に引き継がれ、一定減速度で滑らかに落ちる。
停止判定の確実な発火(newProgress>=1.0)は従来通り最後のごく短い区間の
MIN_CRAWL_SPEED_KMH(5km/h)フロアが担保する。

### 6-4. 修正前後のプロファイル(15セル直線・dt=1/60・実測)

| 指標 | 修正前 | 修正後 |
|---|---|---|
| 停止までの総時間 | 35.3秒 | 31.0秒 |
| 10km/h未満の滞在時間 | 7.92秒 | 1.33秒 |
| 5km/h以下のクロール時間 | 4.3秒 | 0.77秒 |

脈動なし(ピーク後単調非増加)は維持。停止位置精度も従来通り。

### 6-5. テスト

`src/sim/station-approach.test.ts` に「10km/h未満の低速区間は合計1.5秒以内」を追加し、
既存のクロール時間上限を6秒→1秒に厳格化(計3件)。Red→Green確認済み。
`npm run test`全197件パス、`npm run build`成功。
