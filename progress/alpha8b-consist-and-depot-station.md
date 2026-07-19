# v0.1.0-Alpha-8b: 連結車両の滑らか描画と車庫隣接駅のバグ修正

## 問題1: 後続車両のカクつき

`DynamicTrain.tsx` は従来、2両目以降を `runtime.trail`(セル中心列、cars長)にそのまま重ねて配置していた。
先頭は `renderPos`(連続位置)で滑らかに動くのに対し、後続車両はセル境界を跨いだ瞬間にジャンプする
(セル単位の離散配置のため)。

### 対応

- `TrainRuntime` に `pathHistory: Grid[]` を追加。`trail`(占有判定用、cars長)とは別に、描画専用の
  走行履歴を `cars+2` 長で保持する(`simulation.ts` の `pushArrivedGrid`)。両者の先頭は常に一致する
  (`pathHistory[0] === trail[0] === rt.grid`)。
- `src/sim/consist.ts` に純関数 `carPositions(rt, cars, spacing=1.0)` を追加。
  ポリライン `[renderPos, ...pathHistory]` に沿って先頭から弧長 `k×spacing` 後方の点を線形補間で
  サンプリングし、位置とセグメント方向(heading, 正規化済み)を返す。ポリラインが足りない場合は
  最後の点にクランプする。
- `DynamicTrain.tsx` は毎フレーム `carPositions` を呼び、2両目以降の position/lookAt をそれだけで
  決定するようにした(`trail` への直接依存を削除)。

### テスト(`src/sim/consist.test.ts`)

- 直線走行中、隣接車両間隔が spacing(1.0)±0.1 以内であることを300ステップ観測して確認
- 先頭がセル境界を跨ぐ瞬間(dt=0.02s刻み)の前後で2両目の移動量が跳躍しないことを確認
  (1tickの理論最大移動量を超えないことをアサート)
- 45度カーブ区間でも弧長基準の間隔が維持されることを確認

ブラウザでも実際に4両編成をLoad機能経由で走らせ、`carPositions`と同一のサンプリングロジックを
その場でJS評価して隣接車両間隔を検証したところ、直線・カーブとも厳密に1.0(誤差1e-13未満)だった。

## 問題2: 車庫の真ん前に駅があるとバグる(疑い)の調査

`src/sim/depot-station.test.ts` に4シナリオを追加して調査した。

1. 車庫(0,0)隣に駅X(1,0)、その先に駅Y(5,0)。スケジュール[X,Y] → 正常
2. スケジュール[Y,X](先に遠い駅へ) → 正常
3. 4両編成(trailが車庫からはみ出す)でも[X,Y] → 正常
4. スケジュールが[X]のみ(単独駅)で、到着後scheduleIndexが0にループして再びXを目指すケース
   → **バグを発見**。`calculateRoute` は開始セルが既に目的駅ならBFSが即座に空経路 `[]` を返す仕様
   ((`pathfinding.ts` の `if (cell && cell.stationId === targetId) return path;` が `path.length===0`
   で即returnするため)。`stepTrain` はこれを「経路が見つからない」と解釈し、`Waiting for Path...`
   のまま速度0で待ち続け、二度と `arrive` イベントを発行しない(永久Waiting)。

### 修正

`src/sim/simulation.ts` の `stepTrain` で、経路探索結果が空だった場合に「現在セルが既に目的駅か」を
追加でチェックし、該当すれば経路なしとして待機させるのではなく即座に到着処理
(`stopAtStation`、停車時間セット・乗降・事故判定・`arrive`イベント発行)を行うようにした。
到着処理本体は既存の到着時ロジックと重複していたため `stopAtStation` 関数へ切り出し、通常到着
(1マス進行後)と即到着(経路探索で自分の位置が目的駅だった場合)の両方から呼ぶ形にした。

ブラウザでも同一シナリオ(車庫隣接・単独駅スケジュール)をLoad機能経由で再現し、20〜30秒分
`__dbgStep` した結果、`debugStatus` が `Arrived`/`Stopped at Station` を繰り返すのみで
`Waiting for Path...` に陥らないこと、停車→到着イベントが繰り返し(7回以上)発火することを確認した。

## 実装上の注意点

- `TrainRuntime.pathHistory` はセーブデータ(v7以前)に存在しないフィールドのため、
  `persistence.ts` の `deserialiseWorld` で `rt.pathHistory ?? [...rt.trail]` として補う移行処理を追加した。
  SaveDataのバージョン自体は据え置き(v7のまま、実行時ランタイムの内部補完のみ)。
- ブラウザでのUI操作(クリックでの車庫・駅の建設、列車購入)は、キャンバスのraycastが
  隣接セルの当たり判定と競合しやすく、ピクセル単位のクリック座標指定が不安定だった
  (同じ座標でも建設物・駅選択のどちらに解決されるか揺れるケースがあった)。今回はUIクリックでの
  依存構築が不安定だったため、`localStorage`の`cubictransim-save-v1`キーへ直接SaveDataV7形式の
  JSONを書き込み、ゲーム内の「Load」ボタンから読み込ませることで、実際のpersistence層・
  レンダリング層・stepWorldループを通した検証を行った。DIR定数(`src/utils.ts`)のビット値
  (N=128,NE=64,E=32,SE=16,S=8,SW=4,W=2,NW=1)を使わないと接続ビットが噛み合わず経路探索が
  常に失敗するため、検証スクリプトを書く際は必ずこの値を使うこと。
