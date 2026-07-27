# 立体交差(sim層のみ)

## 2026-07-28 追記: 自動高架(直角に敷くと自動でupperになる仕様)を廃止し、橋方式にした

以下の「決定」節に書かれている「直交する線路を敷くと自動的にupper(立体交差)になる」
仕様は**廃止した**。理由は、この仕様だと平面上で線路が直角に交わる
**ダイヤモンドクロッシング**を作れなくなるため(直角に敷いた瞬間に必ず
立体交差化されてしまい、平面のまま交差させる選択肢が無かった)。

新仕様はTTD/OpenTTD流の「橋」方式:
- 直角(あるいはどんな角度)に線路を敷いても、常に地平の`connections`へOR
  するだけになった(`construction.classifyConnectionPlacement`・
  `canMergeSmoothly`・`popcount`は削除。`addConnectionToCell`は単純にORするだけの
  実装に戻した)。直角に交差する線路は4方向接続を持つ1セル(ダイヤモンド
  クロッシング)になり、`pathfinding.ts`の急カーブ制限(内積0.5未満は移動不可、
  `calculateRouteWithStop`内)によって直進のみ通過可能・直角には曲がれない
  (`pathfinding.test.ts`の「平面交差(ダイヤモンドクロッシング)の経路探索」で確認)。
- 立体交差(`CellData.upper`)は`construction.applyBridge(state, path, terrain)`で
  明示的に架ける「橋」でのみ作られるようになった。ドラッグの始点・終点セルが
  **橋台**(地平の通常線路。既存線路があれば接続を足すだけ)、間のセルが
  **橋桁**(`upper.connections`にのみ軸方向の接続を持ち、地平の`connections`は
  一切変更しない)になる。
- 建設可否: 始点〜終点が8方向直線上に等間隔で並んでいること(`getDirFromVector`+
  `getVectorFromDir`で刻み幅を求め、全セルがその直線上にあるか検証)、
  全長(`path.length`、橋台含む)が`MIN_BRIDGE_LENGTH=3`以上
  `MAX_BRIDGE_LENGTH=10`(`construction.ts`で定義、`economy.ts`が再エクスポート)
  以下、橋桁セルが駅・車庫でないこと、橋桁セルに既に`upper`が無いこと(二重架け
  禁止)、橋台セルが水域・山岳でないこと。いずれか1つでも該当すればstateをそのまま
  返すno-op。橋桁の下(地平)は線路・水域・山岳・空地、何であっても関知しない。
- コスト: `economy.costOfPath('bridge', ...)`は、pathの両端2セルを橋台
  (`RAIL_COST`)、残りを橋桁(`RAIL_COST × OVERPASS_COST_MULTIPLIER`)として計算
  する(橋台・橋桁の内訳をpathの位置だけから機械的に決めている)。
  `evaluateBuild`はbridgeモード時に`applyBridge`のdry runで成立可否を判定し、
  成立時のみ`overpassCells`(橋桁セル数)を返す。
- 撤去: `removePath`で橋桁セル(`upper`があり、かつ地平の`connections`も
  独立して存在する=下に別の地平線路が通っている)をpath指定で撤去すると、
  `upper`だけを`undefined`にして地平の線路は残す。隣接セルの接続ビットを
  掃除する既存ロジックについても、掃除した結果`upper.connections`が0になったら
  `upper`プロパティ自体を`undefined`にするよう調整した(以前は
  `{ connections: 0 }`という空のupperが残っていた)。
- UI: `GameUI.tsx`の`BUILD_TOOLS`に「橋」(ショートカット`7`、コスト表記
  `¥400/マス`=`RAIL_COST(100)×OVERPASS_COST_MULTIPLIER(4)`)を追加した。
  色は`ui/theme.ts`に`T.bridge`トークンを追加して経由させている。建設
  フィードバックの表示文言は「立体交差 N(4倍)」から「橋桁 N(4倍)」に変更した。
- `CellData.bridge?: boolean`(水上を渡る線路の見た目・コスト倍率フラグ)と
  `CellData.upper`(立体交差=橋桁)は名前が紛らわしいが別物、という点を
  `types.ts`のコメントに明記した。

### 迷った点・妥協した点

- 橋のコスト計算(`costOfPath('bridge', ...)`)は「pathの先頭・末尾2セルが
  橋台」という位置だけの機械的な判定にしている。`applyBridge`の実際の
  建設可否判定(直線チェック・駅車庫チェック等)とは独立した簡易計算のため、
  no-opになるはずのpathを渡した場合でもコスト自体は計算できてしまう
  (実際の課金は`evaluateBuild`/`commitPath`側で`applyBridge`の結果が
  no-opなら0円のまま、という既存の「変化が無ければ課金しない」仕組みに
  乗っているため実害は無い)。
- 橋の下を通る地平線路との「混線しない」ことの確認は、pathfinding.tsの
  既存の層解決ロジック(`resolveEntryLayer`)がそのまま使えたため、
  橋固有の追加実装は不要だった(橋も立体交差の一種であり、層の概念に
  差はないため)。
- 橋台セル自体が既に駅・車庫だった場合の扱いは明示的な禁止ルールが
  仕様に無かったため、既存の`addConnectionToCell`の挙動(駅・車庫セルへの
  線路接続は既存の`connections`へORするだけ)にそのまま委ねている。

## 決定(旧仕様、履歴として残す。上記の追記により実質廃止)
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

## 描画

- `render/trackGeometry.ts`: `layTrackAlong`/`buildCellTrackParts` に `originY` を追加した。
  中心線の定義(境界点→セル中心(制御点)→境界点の2次ベジェ)は一切変えず、
  バラスト・レール・枕木の生成後に `originY` ぶんだけ y へ加算しているだけなので、
  `trackPath.ts` の走行線とずれない。`originY = OVERPASS_HEIGHT` を渡せば高架側になる。
  併せて `buildOverpassSupportParts()` を追加し、セル全域を覆う桁(デッキ、
  `DECK_SIZE=0.94` の板)とセル中心付近の橋脚(円柱、下端が地面・上端がデッキ下面)を
  1セルぶん生成できるようにした。橋脚は末広がりのテーパー(上半径 < 下半径)にして
  ローポリの模型っぽさを出している。
- `components/TrackNetwork.tsx`: `railMap` を走査するとき `cell.upper` があれば、
  地平の部品に加えて `buildCellTrackParts(cell.upper.connections, x, z, OVERPASS_HEIGHT)` と
  `buildOverpassSupportParts(x, z, OVERPASS_HEIGHT)` の結果も同じ配列に集約し、
  最後に `mergeAndDispose()` でマテリアルごとに1つのジオメトリへマージしている
  (地平と高架で線路のドローコールは共有、桁・橋脚だけ2つ増える=合計5ドローコール)。
  index付き(Box/Cylinder)しか使っていないので `mergeAndDispose` の非index化は
  実質素通りだが、将来他の形状を混ぜる可能性に備えてそのまま使っている。
- `render/palette.ts`: 桁・橋脚用に `overpassDeck` / `overpassPier` の色とマテリアルを追加した
  (既存のバラスト・線路と馴染むよう彩度を落としたグレー系)。
- 列車の高さ: `DynamicTrain.tsx` は先頭車を `runtime.renderPos.y` で配置していたが、
  2両目以降は `CAR_Y = 0.5` 固定になっていた(高架を無視するバグ)。
  `carPositions()` が返す `pos.y`(sim層で計算済み)を使うように修正し、
  編成全体が高架の高さに追従するようにした。JSXの初期position(useFrameが
  一度も走る前の値)は地平の既定値のまま `INITIAL_CAR_Y = 0.5` としている。
- `sim/buildPreview.ts` / `components/GameUI.tsx`: `evaluateBuild` が
  `construction.applyRailPathDetailed` の `overpassCells` をそのまま件数として
  `BuildPreview.overpassCells` に返すようにし、`BuildFeedback` に
  「立体交差 N(4倍)」の表示を追加した(橋・隧道の表示に倣った形)。

### 動作検証で分かったこと・妥協点

- Browser ツールの `left_click_drag`(マウスイベント相当)は `GameScene.tsx` の
  `onPointerDown`/`onPointerMove`/`onPointerUp`(React Three Fiberのポインタイベント)を
  確実には発火させず、ドラッグでの線路敷設がうまく確定しないことがあった。
  検証時は `window.__debugWorld` 相当の仕組みを一時的に拡張し(`setRailMap` などを
  一時的に `window` へ公開して直接 `railMap`/`stations`/`trains` を組み立てる)、
  十字の立体交差と3両編成の列車を用意して確認した。検証用のコードは確認後に
  すべて元に戻している(`src/hooks/useGameLogic.ts` に差分は残っていない)。
- 実機確認では、十字の立体交差で地平・高架それぞれの線路の上に桁と橋脚が
  正しく描画され、列車が高架に差し掛かると `renderPos.y` に追従して滑らかに
  持ち上がり、通過後は滑らかに降りることを確認した。
- 妥協点: `consist.ts` の設計判断どおり、連結車両の y は編成一律(先頭車と同じ
  `renderPos.y`)の近似値である。高架の区間は1セルと短いため、編成が高架へ
  差し掛かる/降りる瞬間は後方車両だけがまだ地平の高さのまま(または逆に
  高架の高さのまま)に見える一瞬が生じる(実機確認のスクリーンショットでも
  最後尾が地平に先に着地し、直前の車両が僅かに浮いて見える瞬間があった)。
  見た目上は編成全体がほぼ同じ高さで動くため実用上気にならない範囲だが、
  より精密にしたい場合は `pathHistory` に層を持たせて `consist.ts` を拡張する
  必要がある(既存の制約セクションに記載済みの想定どおり)。
- 高架と地平が同一セルで重なる見た目については、桁(デッキ)がバラストの
  底面にちょうど接するよう高さを合わせているため、地平の線路とは
  `OVERPASS_HEIGHT`(1.2)ぶん明確に離れて見え、重なりや貫通は生じない。
