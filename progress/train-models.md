# 車種(通勤形/近郊形/特急形)

## 決定
- `TrainData`に`model?: TrainModelId`('commuter'|'suburban'|'express')を追加した。省略(旧セーブ・未選択)は
  `physics.ts`の`trainModelOf(model)`が`commuter`として解決する規約(gauge/power等、既存フィールドと同じ流儀)。
- 車種テーブルは`physics.ts`の`TRAIN_MODELS`に一本化した(旧`TRAIN_SPECS`/`DEFAULT_TRAIN_TYPE`を置き換え)。

  | id | 名前 | 最高速度 | 常用減速度 | enginePower/carMassEmpty/maxTractiveEffort | 価格倍率 |
  |----|------|---------|-----------|---------------------------------------------|---------|
  | commuter | 通勤形 | 100km/h | 24km/h/s | 1400kW / 30t / 300kN | ×1.0 |
  | suburban | 近郊形 | 120km/h | 20km/h/s | 1600kW / 32t / 280kN | ×1.3 |
  | express  | 特急形 | 130km/h | 18km/h/s | 2000kW / 34t / 320kN | ×1.8 |

- commuterが既定かつ旧セーブ互換。ただしenginePower/maxTractiveEffortは旧`TRAIN_SPECS.commuter`
  (1200kW/260kN)から底上げしており、旧セーブの列車も本更新以降は今までよりわずかに速く
  加減速する(=既存の走行感の完全保存は意図的に狙っていない)。
- `MAX_SPEED_KMH`/`DECEL_KMH_S`(simulation.ts)は既定車種(commuter)の値を返すフォールバック定数として
  残した(テスト・他コードの参照互換のため)。実際の走行制御(速度制御・予約延長・加速度計算)は
  すべて`trainModelOf(train.model)`で解決したper-train値を使う。`EMERGENCY_DECEL_KMH_S`(非常制動)は
  車種によらず共通のまま(安全網としての性質上、車種で差を付けない設計判断)。
- 最高速度はレール種別cap(`railWeightSpeedCapKmh`)や他の速度上限とmin合成で効く。特急形の130km/hを
  出すには軌道(何キロレール)モードで60kgレール(上限なし)を敷く必要がある(37kg=70km/h・
  50kgN=110km/hでは上限がそちらに落ちる)。
- 価格: `economy.ts`の`trainCostForProtected(power, protection?, model?)`に第3引数`model`を追加し、
  動力方式(trainCostFor)×保安装置(PROTECTION_TRAIN_PRICE_MULTIPLIER)×車種(priceMultiplier)を
  最後に一度だけ丸めて合成する。既存の呼び出し元(引数省略)は通勤形(倍率1.0)扱いなので挙動は変わらない。
  売却払い戻し(`trainSellRefund`)・複製(`trainTotalCost`)はこの`trainCostForProtected`の結果を
  土台にしているため、車種の価格差はどちらにも自動的に反映される。
- UI: 車庫インスペクタ(`DepotInspector`)の購入セクションに3車種のボタンを常設(ルールモードに
  よらず常に選べる)。在籍列車の行・列車インスペクタのヘッダには`trainModelOf(t.model).name`を表示する。

## 代替案・検討したが採らなかったもの
- `trainCostForProtected`の代わりに`trainCostForConfigured`という別関数を新設する案も検討したが、
  既存呼び出し元(`buyTrain`/`sellTrain`/`cloneTrain`/DepotInspector)を機械的に置き換えるだけの
  二重実装になるため、既存関数へオプション引数を1つ足す形にした。

## 制約・注意点
- `TrainSpec`(physics.ts、enginePower/carMassEmpty/maxTractiveEffort)自体の形は変更していない。
  `TrainModel`がそれを1フィールドとして持つ入れ子構造。
- `simulation.ts`のper-train値配線箇所: `ensureReservation`(予約延長の制動距離)、`stepTrain`冒頭で
  一度だけ`trainModelOf(train.model)`を解決し、以降の停止時減速・release/hardEnvelope・
  overspeed decay・`computeAcceleration`呼び出しすべてで共有する。
- `simulation.test.ts`のH4テスト(在線集合による改軌no-op判定)は、速い車種だと従来の20セル
  トラックが30秒以内に走り切れてしまい「まだ走行中」という前提が崩れたため、60セルへ延長した。
