# 駅セルの接続の軸(ns/ew/cross)

## 決定

`applyStation`(sim/construction.ts)が駅セルへ与える`connections`を、常時4方向(N|E|S|W)固定から
「軸」ベースに変更した。

- 軸は`'ns'`(南北=N|S)・`'ew'`(東西=E|W)・`'cross'`(十字=N|E|S|W)の3種類(`StationAxis`型)。
- 空セルへ新規設置する場合、軸は次の優先順で決まる:
  1. 呼び出し側が`applyStation`の第5引数に明示した軸
  2. 省略時は隣接4セル(N/E/S/W)にある既存の線路・駅セルから推測する
     (南北にあれば`ns`、東西にあれば`ew`、両方あれば`cross`)
  3. 何も無ければ`ew`を既定にする
- 既存の駅セルを直交する軸で横切った場合(=既にそのセルの駅の一部だが、渡された/推測された軸ビットが
  既存connectionsに含まれていない場合)は、駅の統合(stations Mapの更新)は不要のまま
  `connections`だけを`既存 | 新しい軸ビット`に拡張する(十字化)。
- 既存connectionsに新しい軸ビットが全て含まれる場合(=同じ軸の再設置、または旧セーブの4方向駅への
  再設置)は真のno-op(バグ1/2対策の再設置防止を維持)。

呼び出し元の対応:

- ドラッグ設置(useGameLogic.tsのcommitPath): GameScene.tsxのhandlePointerUpで
  ドラッグ開始位置と終了位置のベクトルから`ew`/`ns`を判定してヒントとして渡す
  (押下位置=解放位置で判定できない場合はヒント無しにし、`applyStation`の推測に任せる)。
- テンプレート設置(stationTemplates.ts): `TemplateCell`に`axis`を追加し、`rotateTemplate`が
  90度回転(quarterTurns奇数)のときに`ns`⇄`ew`を入れ替える(`cross`は常に`cross`)。
  これにより十字乗換駅の中心セルは`cross`、腕は`ns`/`ew`、相対式2面2線は全セル`ew`(既定)
  →回転すると`ns`になる。

## 代替案として検討したもの

- `CellData`に`axis`フィールドを追加して保持する案 → 却下。`connections`ビット自体が
  軸の実体であり、二重に状態を持つと不整合(axisとconnectionsが食い違う)の温床になる。
  描画側(`StationBlock.tsx`の`trackAngleFromConnections`)も元々connectionsから向きを
  決めていたため、connectionsを正しく絞るだけで描画は自動的に直った(変更不要)。
- マイグレーションで旧セーブの4方向駅を軸推定して絞り込む案 → 却下(要件通り)。
  絞り込みの誤判定で実際に必要な接続を消してしまうと列車が孤立するおそれがあるため、
  旧セーブは4方向のまま読み込む(実質的に「常にcross」として扱われる)。

## 落とし穴

- 十字駅の「交差」は、あくまで**同じセルを両方の軸で明示的に踏んだ場合**にのみ発生する。
  隣接する別軸の駅セルとマージされただけ(=セルそのものは片方の軸でしか設置されていない)では
  connectionsは拡張されない。既存テスト(construction.test.ts・pathfinding.test.ts)は
  「隣接マージ」と「実際に軸を交差させる」を区別するよう明示的に軸を渡す形へ更新した。
- `evaluateBuild`/`evaluateStationTemplate`(buildPreview.ts)は軸を渡していない
  (常に推測任せ)。実際の設置可否判定(no-opかどうか)には影響しないため据え置いた。

## 実機確認(2026-07-28)

`駅テンプレ`(8キー)→「相対式2面2線」を選択して設置→`connections=34`(E|W)。
`R`キーで90度回転してから再度設置→`connections=136`(N|S)。スクリーンショットでも
ホームの向きが実際に90度違うことを確認した(駅名: 長浜駅=東西向き、北浦駅=南北向き)。

## 追記(0.5.0-Alpha-4b): 既存線路上クリックで軸ヒントが直交してホームが線路とズレる不具合を修正

### 根本原因

長年存在していた設計上の抜け穴(新規機能ではなく既存の穴、ユーザー報告で顕在化)。

`GameScene.tsx`のドラッグ軸ヒント(`stationAxisHint`)は、station建設モードの
`path`が常に単一セル(`[pos]`、マウスアップ位置のみ)であるにもかかわらず、
`pos`と`dragStartRef`(マウスダウン位置)の差分だけから`ew`/`ns`を機械的に決めていた。
実際のクリックでも、マウスダウンとマウスアップの間にセル境界をまたぐ1セル分のブレが
起きるとヒントが立ってしまう。このヒントは`applyStation`側で無条件に信用され、
`existingBits | axisBitsFor(hint)`として実connectionsへORされていたため、
既存の東西(または南北)直線の上でクリックしただけで、実在しない直交方向の
connectionsが混入していた(例: `E|W`の直線に`ns`ヒントが乗ると`N|E|S|W`のフルクロス
になってしまう)。connectionsはpathfindingが直接使う値であり、駅の統合とは無関係に
「実在しない分岐」が生まれる。

描画側`trackAngleFromConnections`(`render/stationGeometry.ts`)は
`BOUNDARY_OFFSETS`順で最初に見つかったビット(`N`が最優先)を採用するだけだったため、
フルクロス化したconnectionsからは常に`N`が選ばれ、東西の線路にホームが南北向きで
乗ってしまう(ユーザー報告の見た目そのもの)。

### 修正

- `sim/construction.ts`: `applyStation`の軸解決を「対象セルが既に何らかの接続
  (`ownConnections`)を持つ場合、ヒントの軸方向に実在する隣接rail/stationセルが
  無ければヒントを採用しない」というゲート(`axisHintIsSupported`)へ変更した。
  空セルへの新規設置(`ownConnections===0`)ではヒントをそのまま信用する(駅スタブの
  初期方向決定に必要、従来通り)。十字乗換駅のようにヒント方向へ実際に線路/駅セルが
  隣接している場合は従来通りヒントを信用しcrossを形成できる
  (`construction.test.ts`/`pathfinding.test.ts`の十字駅テストは無改変で通過)。
- `render/stationGeometry.ts`: `trackAngleFromConnections`に、対向2方向が両方立った
  「通り抜けの直線」を単独ビットより優先するフォールバックを追加した(カーブ・接合部・
  旧セーブの混在connectionsに対する頑健化。今回のconnections汚染そのものは止血できないが、
  仮に汚染が起きても向きのズレを軽減する第二の防御線)。

### ブラウザ実機確認(2026-08-11)

`PointerEvent`をJSから直接dispatchし、E-W直線・N-S直線それぞれに対して意図的に
1セルずれたmousedown→mouseup(=軸ヒントが直交して立つケース)で駅を設置。
いずれも`connections`が実際の直線の軸のまま(E-W線は`E|W`=34、N-S線は`N|S`=136)で
ホームが線路方向に正しく描画されることをスクリーンショットで確認。デバッグシナリオ
「坂・高架・往復列車」を読み込み、`__dbgStep`で列車を往復走行させ、地平区間の駅への
到着・停車・折り返しが従来通り機能することも確認した(routingは無傷)。
