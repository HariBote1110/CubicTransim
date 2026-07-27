# 駅の発車標(接近案内)

## 決定
- 表示場所は駅パネル(`StationInspector`)内の一節。3Dの看板は作らない。既存の「待ち客の行き先」の直前に配置した。
- 到着予測は `src/sim/arrivals.ts` の `computeStationArrivals()` に純粋関数として実装した。React/THREE に非依存。
  - 対象: `train.status === 'running'` かつ、`effectiveSchedule(train, groups)[train.scheduleIndex]` がその駅である列車。
  - 残り距離: `TrainRuntime.route` を `simulation.ts` の `distanceAlongRouteTo` と同じ考え方(現在位置(grid+progress)からroute末尾までの弧長、1セル=TILE_LENGTH×√2斜め)で計算。`simulation.ts` 自体は変更していない(ロジックだけ写した)。
  - 到着秒数 = 残り距離 ÷ 実効速度。実効速度は `Math.max(rt.speedKmh, 20)` で下限クランプし、停車中・発進直後でも秒数が発散しないようにした。
  - 停車中(`stopRemaining > 0`)は0秒・`isStopped: true` として先頭に出す。
  - 行き先は `stopsOnCurrentRun(schedule, {index, direction}, mode)` の先頭要素(=「今の目的駅の次に停まる駅」)。環状/折返しの両方に対応する既存ロジックをそのまま使う。
  - 単独運用(`groupId` 未設定)は路線名「単独」、色はニュートラルなグレー(`#8a8f98`)で表示する。
- UI側 (`GameUI.tsx`) は既存の `POLL_INTERVAL_MS`(400ms)ポーリングに乗せて `computeStationArrivals` を呼ぶ。駅を選択しているときだけ計算し、全駅ぶんは毎回計算しない。最大5件で打ち切り。

## 精度についての妥協点(意図的にやっていないこと)
- 信号待ち・発車間隔(headway)による停止/減速は一切織り込んでいない。経路残距離と速度だけの単純計算。
  - 実測では、詰まっている区間(先行列車が同じホームに停車中など)がある場合、実際の到着はここに出る秒数よりかなり遅れうる(単線ですれ違い待ちが発生するケースなど、数十秒〜のずれが起こり得る)。
  - 逆に、まだ経路すら計算されていない列車(`rt.route.length === 0`、出発直後で1tick未処理)は残り距離0として「まもなく」表示になり得るため、一瞬だけ実態より早く見えることがある。
- 速度の推定は「現在速度」を採用し、下限20km/hでクランプするだけに留めた(路線ごとの巡航速度平均は使っていない)。停止直前・発進直後は速度が実際の巡航速度より低いため、その区間だけ到着予測が若干甘く(早く)出る。

## 動作確認
- `npx vitest run` で `src/sim/arrivals.test.ts` の6件を含む全373件が通過。
- `npx tsc -b` / `npm run build` が通ることを確認。
- ブラウザで `window.__debugWorld` を直接組み立て(2駅・単線・列車3本)、localStorageのセーブキーへ書き込んで「読込」ボタンでReact stateに反映させ、駅パネルの発車標に3件表示されること、`window.__dbgStep` で時間を進めると秒数が減っていくこと(例: 4両 約21秒→約16秒)を確認した。
