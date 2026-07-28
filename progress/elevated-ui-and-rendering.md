# 立体交差の高架UI・描画対応

## 決定

- ツールバーの`7`(旧「橋」)を「高架」に置き換え、`applyElevatedPath`をドラッグで敷く操作にした。
  曲がってよく長さ制限が無いため、rail/removeと同じ`getConstrainedPath`ベースのドラッグ経路を
  そのまま使う。空いた`8`は「高架駅」とし、`applyElevatedStation`を使う。station/depot/signalと
  同じ「ドラッグの解放位置1セルだけを`commitPath`に渡す」経路に合流させ、地平の駅ツールと
  同じ操作感にした。
- `GameUI.BuildMode`・`GameScene`の`onCommitPath`のmode引数から`'bridge'`と`'template'`を外し、
  `'elevated'`/`'elevated-station'`に置き換えた。`useGameLogic.commitPath`も同様。コスト計算は
  UIに書き写さず、`elevated`は`sim/construction.ts`の`resolveElevatedPathEnd`/`planElevatedPath`
  (buildPreview.tsと同じ関数)に問い合わせてから`economy.costOfElevatedPath`へ渡し、
  `elevated-station`は`economy.ELEVATED_STATION_COST`固定。
- 建設プレビュー(GameScene)は、`elevated`のとき`previewPath`の各セルの役割
  (`planElevatedPath`の`roles`)を見て、坂(ramp)は警告色、高架のまま(span)は橋色に塗り分ける。
  `GameUI.BuildFeedback`は`preview.rampCells`/`overpassCells`の内訳を「坂 N」「高架 N(4倍)」として
  表示する(`evaluateBuild`が既に算出済みの値をそのまま出すだけで、UI側で再計算しない)。
- 高架駅セルの描画は前段(cdeb606)で用意済みだった`render/stationLayers.ts`の
  `groundStationCells`/`elevatedStationCells`/`computeStationEndKeys`/
  `elevatedCellCandidateFromGroundClick`をそのまま使い、GameScene側で車輪の再発明をしていない。
  高架駅セルは`elevatedStationCells(railMap)`で集計し、`StationBlock`を`OVERPASS_HEIGHT`ぶん
  持ち上げた位置(`[x, OVERPASS_HEIGHT, z]`)に、`data.upper.connections`を渡して描く。ホーム端
  (妻面の柱)の判定は地平・高架それぞれ独立に`computeStationEndKeys`へ渡して求める(層をまたいだ
  近傍は数えない)。
- 高架ホームの下の桁・橋脚・橋台は追加実装が不要だった。`applyElevatedStation`は
  「既に`upper.connections`を持つセル」にしか駅を置けない制約があるため、駅化しても
  `TrackNetwork.tsx`の既存の`data.upper`判定(桁・橋脚を描く条件)がそのまま成立し続ける。
  地平ホームの真上を高架ホームが跨ぐケースも、桁の描画はセルごとに独立しているため
  特別扱い不要だった。
- 駅舎(`StationHouse`)とラベル(`StationLabel`)は1駅につき1つに統一した。十字乗換駅は
  `StationData.cells`に地平(layer省略/0)と高架(layer:1)の両方が入るため、素朴に
  `station.cells`全体の中央値を使うと二重描画やめり込みが起きる。地平セルがあれば
  そちらを優先して駅舎の位置・向きを決め(`ownGroundCells`)、無ければ高架セルを使う。
  ラベルは高架セルを含む駅だけ`1.35 + OVERPASS_HEIGHT`の高さに上げ、地平のみの駅は
  従来通り`1.35`のまま(`StationLabel`に`labelY`propを追加)。
- クリックでの高架駅選択は、直交カメラの視線方向(-1,-1,-1)固定という制約から、
  地平面(y=0)へのレイキャストが実際にはずれた位置に当たる性質を逆手に取った
  `elevatedCellCandidateFromGroundClick`を使う。地平セルへのヒットが無かった場合だけ
  この候補座標を`railMap`で引き、`upper.stationId`があれば駅選択/運行表追加に使う。
  カメラ角度依存の近似なので完璧な判定ではないが、実用上は問題ない(設計はstationLayers.ts
  のコメント参照)。

## 実機確認結果(Browserツール、`preview_start` name "dev")

- `2`キーで地平の線路を東西に敷設(`(5,-1)`〜`(7,-1)`)→`7`キーで高架を`(6,-3)`〜`(6,1)`へ
  南北にドラッグ敷設したところ、交差点`(6,-1)`が自動的に高架化(`upper.connections`付与)され、
  両端2セルずつが坂(`ramp.level 1/2`)になった。プレビュー中は坂セルが警告色、中間の高架セルが
  橋色で塗り分けられて見えた。
- `3`キーで交差点`(6,-1)`に地平駅を設置したところ、`applyStation`(sim/construction.ts、
  他エージェント管轄でありUI側からは変更できない)が`railMap.set(key, { type:'station', ... })`で
  セルを丸ごと差し替えており、既存の`upper`(高架の橋桁)が消えてしまうことを実機で確認した
  (`window.__debugWorld.railMap.get('6,-1')`に`upper`が無くなる)。高架線を再度同じ経路へ
  敷き直す(`applyElevatedPath`は`upper`を持たないセルに対して`{...existing, upper: {...}}`と
  スプレッドするため副作用なく復元できる)ことで回避し、検証を続行した。この現象自体は
  sim層(`applyStation`)の既知の不整合としてこの後段で報告する(担当外につき本セッションでは
  修正していない)。
- `8`キーで高架セル`(6,-1)`をクリックして高架駅を設置。`window.__debugWorld.stations`で
  該当駅IDの`cells`配列に`{x:6,z:-1}`(地平)と`{x:6,z:-1,layer:1}`(高架)の両方が入っている
  ことを確認した(`applyElevatedStation`が地平駅と正しく統合)。
- 高架駅設置後のスクリーンショットで、地平ホームの真上に高架ホームが架かり、桁が地平ホームを
  跨いで描かれていること、駅名ラベル「新野駅」が1つだけ表示されていることを確認した
  (地平・高架で二重表示されない)。
- 選択モード(`1`キー)で、高架ホームが視覚的に見える位置(地平面上では実際には別セルに
  当たる位置)をクリックしたところ、`elevatedCellCandidateFromGroundClick`による逆算で
  正しく「新野駅」が選択され、駅インスペクタ(ホーム長2マス=地平+高架)が開くことを確認した。

## 既知の制約(sim層のバグ、担当外)

- `sim/construction.ts`の`applyStation`は、既存セルを駅化する際に
  `railMap.set(key, { type: 'station', connections, stationId: targetId })`と新規オブジェクトで
  丸ごと置き換えており、既存セルが持っていた`upper`(高架の橋桁/高架駅)・`ramp`・`bridge`・
  `tunnel`を保持しない。これにより「高架線が通っているセルに地平駅を後から重ねる」操作をすると
  高架線が消えてしまう(本ファイルの実機確認で発生し、高架線を敷き直して回避した)。
  `applyElevatedPath`の同等コードは`{...(existing ?? {type:'rail'}), ...}`とスプレッドしており
  この問題が無い。UI側からは修正できない(`src/sim/`は担当外)ため、sim層の担当エージェントに
  申し送りが必要。

## 既知の制約(UI側)

- `elevatedCellCandidateFromGroundClick`はカメラの位置・角度が変わらない前提の近似判定。
  カメラのズーム操作(OrbitControlsのDOLLY/PAN)自体は視線方向を変えないため影響は無いはずだが、
  将来カメラの回転操作を追加する場合はこの関数も合わせて見直す必要がある。
- `previewPath`の高架駅(elevated-station)ドラッグは、地平の駅ツールと同じく「ドラッグ解放位置の
  1セルだけ」を設置する仕様。連続設置(ドラッグで複数セルに順に設置)は行っていない
  (地平駅ツールも同様の仕様のため、操作感を揃える方針に従った)。
