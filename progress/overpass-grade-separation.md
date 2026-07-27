# 立体交差(sim層のみ)

## 決定
- `CellData.upper?: { connections: number }` を追加し、地平(`connections`)と別の
  第2の線路を1セルに持てるようにした。列車には層を持たせない。「そのセルに
  どちら向きで入ったか」(進入方向の逆ビットが地平/upperのどちらのconnectionsに
  立っているか)から一意に決まるため、TrainRuntimeやセーブデータに層フィールドを
  増やす必要がない。
- 経路(`{x,z}`)には `layer?: 0 | 1` を任意で持たせる。地平は省略(undefined)のまま
  にして、既存テストの `toEqual` がそのまま通るようにした(jest/vitestの`toEqual`は
  undefinedプロパティを「無い」のと同一視するため)。
- `pathfinding.ts`: BFSの各ノードが「今いる層」を保持し、その層の`connections`
  だけを使って移動先候補を出す。隣セルへ移るときは
  `resolveEntryLayer(railMap, next, curr)` で進入方向の逆ビットから相手セルの層を
  解決する。どちらの層にもビットが無ければ移動不可(nextLayer=null)。
  BFSのvisitedキーは `x,z:layer` にして、同じセルを異なる層で2回訪問できるように
  した(交差点そのものは1回しか通らないが、visited管理としては層ごとに別ノード)。
- `reservation.ts`: `reservationKey`が層込みのキーを返す(地平は従来通り`"x,z"`、
  高架は`"x,z:u"`)。これにより地平と高架が別の閉塞資源になり、交差する2列車が
  同時にすれ違える。`isSafeWaitingPoint`は`upper`を持つセル(交差セル)を常に
  safe waiting point対象から外した(高架の上で停止させない)。
- `construction.ts`: `applyRailPath`が新方向を敷くとき、既存の`connections`の
  どれとも「なだらかに繋がらない」(方向ベクトルの内積の絶対値が0.5未満)なら
  `connections`ではなく`upper.connections`へ入れる
  (`classifyConnectionPlacement`)。絶対値を使うのは、`connections`のビットが
  「セルからその隣へ track が伸びている向き」を表す無方向集合であり、直進継続は
  正反対のビット同士(内積-1)になるのが普通だから(素の内積だとまっすぐ延長する
  だけで立体交差になってしまう)。駅・車庫セルは常に地平へ合流し立体交差にしない。
  既に`upper`があるセルへさらに繋ぐ場合はupper側の合流可否だけを見て、
  どちらとも繋がらなければno-op(3層は作らない)。`removePath`は地平・高架両方の
  connectionsビットを掃除する。
- `economy.ts` / `buildPreview.ts`: `OVERPASS_COST_MULTIPLIER = 4`を追加。
  `costOfPath`に`railMap`を渡すと、内部で`construction.applyRailPathDetailed`
  (dry run)を呼んでどのセルが立体交差になるか判定し、そのセルだけ
  `RAIL_COST × 4`にする。`evaluateBuild`はrailモードのときだけ`railMap`を渡す。
- `simulation.ts` / `trackPath.ts`: `trackPath.OVERPASS_HEIGHT = 1.2`を追加。
  `TrainRuntime`内部で使うGrid型に`layer?: 0 | 1`を足し、`renderPos.y`を
  `0.5 + (layer===1 ? OVERPASS_HEIGHT : 0)`相当にした。セル遷移中
  (progressが0→1へ進む間)は`interpHeightForLayer`で区間内を線形補間し、
  高さが飛ばないようにしている。立体交差は基本1セルだけの短い区間なので、
  補間区間もそのぶん短い(急な上下になる)。
- `consist.ts`: `CarPosition`に`y`フィールドを追加。編成内の全車両で
  `rt.renderPos.y`を共用する簡略化(pathHistoryに層を持たせていないため、
  車両ごとに正確な高さは出せない)。立体交差が1セルの短い区間である前提のもとでは
  実用上気にならない近似としている。より精密にしたい場合はpathHistoryへ層を
  追加してconsist.tsを拡張すること。

## 代替案として検討したもの
- 列車(TrainRuntime)に`layer`フィールドを直接持たせる案は採用しなかった。
  「進入方向から一意に決まる」という性質があるため、セーブ不要な派生値として
  都度計算できるほうがシンプルで、セーブ互換の考慮も増えないため。
- 立体交差の判定基準を内積の符号付きの値(0.5以上)にする案は、直進継続(正反対の
  ビット、内積-1)まで「なだらかに繋がらない」と誤判定してしまうため不採用。
  絶対値を取ることで「直進・浅い曲がり」は合流、「直交・鋭い交差」は立体交差、
  という直感通りの境界(60°)になる。

## 制約・注意点(描画側が知っておくべきこと)
- **高架セルの判別方法**: `CellData.upper !== undefined`。`upper.connections`が
  高架側の接続ビット。
- **経路セルのlayer**: `pathfinding.calculateRouteWithStop`が返す`RouteResult.path`
  の各要素に`layer?: 0 | 1`が付く(地平はundefined、高架は1)。
- **列車のyの求め方**: `TrainRuntime.renderPos.y`をそのまま使えばよい(sim層側で
  高さ込みの値になっている)。`consist.carPositions()`の戻り値にも`y`が付くように
  なったが、編成内は一律の高さ(近似)である点に注意。
- 8方向グリッド(45°刻み)と内積閾値0.5(=60°)の組み合わせでは、「地平ともupperとも
  合流できない(blocked)」状態は、ground軸とupper軸が非退化(互いに平行でない)な
  通常の交差では原理的にほぼ到達しない(2つの非平行軸は必ず全8方向のどれかと
  60°以内で重なるため)。`classifyConnectionPlacement`の`blocked`分岐は
  将来的な拡張(例: より細かい角度分解能)や異常系に備えた防御的な実装として残して
  いる。construction.test.tsのblocked相当のテストは、railMapを手動編集して
  片方向だけの`upper`を作る形で再現している。
- 信号の向き判定(`signalDir`)は層を区別していない(既存のまま)。立体交差の
  高架側に信号を置く運用は今回のスコープ外。
