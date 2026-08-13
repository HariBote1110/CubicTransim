# 架線ワイヤーの高さ・駅舎の左右回避(0.5.0-Alpha-15b)

## 決定1: 架線マスト・電線の高さを引き上げ

### 背景
`trackGeometry.ts`の架線定数は`CATENARY_MAST_HEIGHT = 0.55`・
`CATENARY_WIRE_HEIGHT = 0.5`（いずれも`originY`＝レール上面基準）だった。
一方で列車の車体は`trainMeshBuilder.ts`/`consist.ts`の`trackCentreHeight`から
`surface+0.385〜+0.635`、屋根上のクーラーは`surface+0.713`まで達する。
電線0.5はクーラー0.713より低く、走行中の車両へ電線が食い込んで見えていた。
さらに架線アームの取り付け高さは`originY + CATENARY_MAST_HEIGHT - ARM_THICKNESS/2`
（≈0.525）で、電線(0.5)より高い位置にアームがある逆転も起きていた。

### 決定
- `CATENARY_MAST_HEIGHT`を`0.55→0.85`に引き上げ、クーラー天面(0.713)へ
  十分な余裕(≈0.09)を残して電線がクリアするようにした。
- `CATENARY_WIRE_HEIGHT`を独立定数から、
  `CATENARY_MAST_HEIGHT - CATENARY_ARM_THICKNESS/2 - CATENARY_WIRE_DROP`
  (`CATENARY_WIRE_DROP = 0.025`)という導出式に変更。アーム取り付け高さから
  わずかに垂れ下がった位置に電線を張ることで、マスト・アーム・電線の
  高さ関係が常に整合する（アームより上に電線が浮く矛盾が構造的に起きない）。
  結果として電線高さは0.85−0.025−0.025＝0.80で、クーラー0.713を上回る。
- マスト幅・アーム長など横方向の寸法は変更していない（見た目の太さ・張り出しは従来どおり）。

### 代替案・不採用
- 電線高さだけを個別に0.8へ書き換える案は、将来マスト高さだけ変更したときに
  再びアーム・電線が矛盾する再発リスクがあるため不採用。導出式にして
  一次情報源をマスト高さ1つに絞った。

## 決定2: 駅舎の左右回避ロジック

### 背景
`stationGeometry.ts`の`buildStationHouseGeometries`はローカル+X側へ常に固定
オフセット(0.95)で駅舎を置いていた。駅の中心セルの+X側が別の線路・駅セルに
占有されている場合でも回避せず、駅舎が線路に重なって描画されるバグがあった。

### 決定
- `buildStationHouseGeometries(position, angle, side: 1 | -1 = 1)`に`side`引数を追加。
  ローカル+Xオフセットへ`side`を乗算するだけで、既定(`1`)は従来どおりの
  無回帰互換の挙動になる。
- `stationLayers.ts`に純粋関数`decideStationHouseSide(centreX, centreZ, connections, isOccupied)`
  を追加。占有判定`isOccupied(x,z)`は呼び出し側が用意する（地平は`railMap`の
  該当セルの存在、高架/地下は`uppers[level]`の存在で判定が異なるため、この
  関数自体は地形やrailMapの構造を知らない）。
  - `trackAxisVectorFromConnections`（`trackAngleFromConnections`の角度版から
    ベクトル版を切り出した新エクスポート）で軌道軸を求め、90度回転した
    整数オフセットで+X側／-X側の隣接セル座標を算出する。
  - +X側が占有かつ-X側が空いていれば`-1`を返す。両側空・両側占有はどちらも
    `1`のまま（両側占有は回避不能で、建設側の`stationAxisConflict`等で
    そもそも起きにくいケースのため、描画側では無理に解決しない）。
- `computeStationHousePlacement`の戻り値`StationHousePlacement`に`side`を追加し、
  駅の中心セル・接続方向・`houseIsElevated`/`houseLevel`から`isOccupied`を
  組み立てて`decideStationHouseSide`を呼ぶ。

### 未配線の部分（フォローアップ）
このタスクは`src/render/`配下のみを対象としたため、実際に`side`を使って
描画するのは呼び出し元`src/components/WebGpuStations.tsx`
（`buildStationHouseGeometries(placement.position, placement.angle)`）の
役目だが、今回は変更していない（`side`を渡していないので既定の`1`のまま）。
`WebGpuStations.tsx`側で`placement.side`を第3引数として渡す1行の変更を
別コミットで行う必要がある。

### テスト
`src/render/stationLayers.test.ts`に`decideStationHouseSide`のテストを追加。
南北軸・東西軸それぞれで「+X側占有→-1」「両側空→1」「両側占有→1」を確認。
