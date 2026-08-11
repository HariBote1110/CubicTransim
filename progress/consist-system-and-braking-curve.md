# 編成(consist)システムと減速カーブの改善

## 決定

### 編成システム
- `TrainData.cars: number`(1〜8)を追加。新規購入時は2両編成として作成する。
- 経済定数を編成両数ベースに置き換えた:
  - `TRAIN_UPKEEP`(定額500)→`UPKEEP_PER_CAR`(250/両)。`calculateUpkeep`は
    `world.trains`の`cars`合計×`UPKEEP_PER_CAR`で計算する。
  - `TRAIN_CAPACITY`(定額100)→`CAPACITY_PER_CAR`(50/両)。定員は`cars×CAPACITY_PER_CAR`。
  - `TRAIN_COST`(5,000)は据え置き(2両編成の新造価格)。増結`CAR_COST`(2,000)/
    解結払い戻し`CAR_REFUND`(1,000)を新設。
- `simulation.ts`の`TRAIN_LENGTH_TILES`定数は廃止し、`rt.trail`の物理長上限は
  `train.cars`を都度参照するようにした(`stepTrain`内で`train.cars ?? 2`を使用)。
- ホーム長ペナルティ: 到着したstationIdセルが属する駅の`StationData.cells.length`を
  ホーム長とみなし、`cars > platformLen`のとき
  `stopRemaining = STOP_DURATION × (1 + 0.5 × (cars − platformLen))` とする。
  ホーム長以下ならペナルティなし(倍率1)。
- 車庫在籍中(`status === 'stored'`)の列車のみGameUI上で増結・解結ボタンを表示する
  (`useGameLogic.addCar`/`removeCar`)。走行中は編成を変更できない仕様のため。
- DynamicTrainは`data.cars`分の車両を描画する。2両目以降は`runtime.trail`のセル列
  (先頭が現在セル)に沿って1タイル間隔で後方配置する。発車直後などtrailの長さが
  carsに満たない間は先頭セルに重なって描画される(仕様通りの許容挙動)。

### 減速カーブ
- 従来は「現在速度からの制動距離(等加速度の公式を現在速度基準で算出)」と
  見通し距離を比較して目標速度を3値(MAX/MIN_CRAWL/0)で切り替える方式だった。
- 新方式は見通し距離から逆算する連続的な許容速度曲線に変更した:
  `permittedSpeed = sqrt(2 × DECEL(m/s²) × max(0, limitDistance − margin))`
  (margin=`BRAKING_MARGIN_M`=0.5m)。`targetSpeed = min(MAX_SPEED_KMH, permittedSpeed)`。
- 障害物が駅のときのみ`MIN_CRAWL_SPEED_KMH`を下限保証する(到着判定=
  `newProgress >= 1.0`を確実に発火させるため、駅前で速度0のまま停止してしまう
  ことを防ぐ)。信号待ち・他列車待ちの場合は下限を設けず0まで落としてよい。
- `immediateBlock`(直前セルの物理的占有)の場合は従来通り即座に速度0にする。

## 代替案として却下したもの
- ホーム長ペナルティの判定を「駅の全セルの中でcarsが収まるか」のような複雑な
  幾何判定にする案 → 過剰仕様。`StationData.cells.length`(建設された駅セル数)を
  そのままホーム長として扱う単純な仕様で十分と判断した。
- DynamicTrainで各車両ごとに個別のRigidBody的な物理演算を行う案 → sim層は
  「先頭のgrid/progress」のみを追跡する設計のため、後続車両は`trail`という
  離散セル列に沿わせるだけの簡易表現とした(セル間の補間は行わず、folded line
  補間で妥協)。

## テスト構築上のハマりどころ(Gotcha)
- `sim/simulation.test.ts`のヘルパー`buildStraightLine`/`buildTwoStationLine`は、
  railMap上に複数の`stationId`セルを物理的に作ると、`pathfinding.ts`の
  `calculateRoute`がstationId一致セルに到達した時点で経路探索を打ち切ってしまい、
  意図した「駅の中心セル」まで到達せず手前で停車してしまう(既存の
  `stepTrain`内のkeepGoingロジックは、pathfindingがそもそも深い側のセルを
  routeに含めている場合にしか効かない)。
  → ホーム長を検証したいテストでは、railMap上のstationセルは従来通り1つのまま
  にして、`StationData.cells`配列だけダミー座標でplatformLen件分用意する
  (乗降・停車判定は`cells.length`しか見ないため、経路探索とは独立に検証できる)。
- `pathfinding.ts`のBFSは`MAX_DEPTH = 300`で打ち切られる。減速カーブのテストで
  100km/hからの制動距離を確保するために直線長を400セルにしたところ経路が
  見つからず`Waiting for Path...`のまま停止してしまった。250セル程度に短縮して
  対応した。
- `STATION_WAITING_CAP`(200)は`CAPACITY_PER_CAR × 8`(400)より小さいため、
  8両編成の乗車テストは「定員まで乗る」を直接検証できない
  (駅の待ち人数自体が200で頭打ちになる)。8両境界のテストは
  `Math.min(8 × CAPACITY_PER_CAR, STATION_WAITING_CAP)`を期待値とし、
  容量計算式自体が正しく効いていることを確認する形にした。
