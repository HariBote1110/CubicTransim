# P8: 地下線・地下駅の設計

## Decision

多レベル高架(uppers: 1..3)を**負のレベルへ対称拡張**する。データモデル・経路探索・予約・
運行は高架で確立済みの仕組み(レベル別 connections、層別予約キー、レベル遷移の坂)を
そのまま下方向に使い、新規性は「出入り」「描画」「コスト」の3点に絞る。

1. **データモデル**: `CellData.uppers: Partial<Record<1|2|3, ...>>` を
   `levels: Partial<Record<-3|-2|-1|1|2|3, ...>>` へ一般化(識別子は `layers` 等、実装時に
   既存コードと衝突しない名前を選ぶ)。地平(0)は従来どおり CellData 本体。
   ramp.base の一般化で負レベルへの坂(掘割)も同型に表現する
2. **出入りは掘割ランプ**: 高架の坂と対称の「掘り下げ坂」。地表の flat セル(任意標高)から
   1セルで -1 レベルへ降りる。傾斜地の坑口直下型(横穴)は導入しない(P7 のトンネルが
   その役割を既に果たしている)
3. **描画は地下ビュー切替(A列車/Simutrans方式)**: 表示レベルの選択(建設レベル選択の
   ArrowUp/Down を拡張)で「地下モード」に入ると、地表・高架を薄暗い半透明(または
   ワイヤー的な淡色)にし、選択中の地下レベルの線路・駅・列車を通常輝度で描く。
   カットアウェイは採用しない(アイソメ固定カメラでは遮蔽計算が複雑な割に視認性が低い)
4. **地下の建設制約**: 町タイル・地形種別(mountain 表示区分)を無視できる。ただし
   (a) water セルの直下は不可(初版の安全側。次版で「水底トンネル」として緩和検討)
   (b) 標高hのセルの地下レベル-1は「世界標高 h-1 の絶対レベル」ではなく
   「地表からの相対深さ」とする(地表に追従する。TTDの地下とは異なるが、
   掘割ランプの成立条件が単純になり、16K の起伏でも使い勝手が安定する)
5. **コスト**: 地下線路は RAIL_COST×6、地下駅は ELEVATED_STATION_COST×3(初版値。
   「制約がない代わりに高い」の原則。バランスは実プレイで調整)
6. **地下駅**: 高架駅(applyElevatedStation)と対称の applyUndergroundStation。
   1駅IDに地上・高架・地下ホームを混在可能(StationData.cells[].layer の一般化)。
   乗換は既存の同一駅ID機構で自動成立
7. **セーブ**: v15 の cells シリアライズを層一般化に追従(pre-release につき version 据え置き
   可否は実装時判断。形が大きく変わるなら v16 に上げてよい — 旧セーブ読み捨て許容は継続)

## 実装順(サブフェーズ)

- P8a: sim データモデルの層一般化(uppers→両符号レベル)+construction の
  applyUndergroundPath/Station+掘割ランプ。pathfinding/reservation の層キー対応。TDD
- P8b: 描画 — 地下ビュー切替、半透明地表、地下レール/駅/列車、掘割の開口部表現
- P8c: UI — レベル選択の負方向拡張、地下モードのツールバー表示、コスト表示

## Alternatives considered

- **絶対深度(TTD式)**: 棄却(初版)。起伏の激しい 16K 地形では「どの絶対レベルなら
  地表に出られるか」の把握が難しく、掘割ランプの成立条件も複雑化する。相対深さなら
  「どこでも1セルで潜れる」が常に成り立つ
- **カットアウェイ描画**: 棄却。上記3参照
- **横穴坑口(傾斜面への地下入口)**: 棄却(初版)。P7 トンネルと役割が重複する

## Constraints / Gotchas

- 相対深さ方式では、地表の標高が違うセル同士の地下-1 は「同じ-1」でも世界高さが異なる。
  地下の隣接接続にも P7 と同じ「辺標高の連続性」検査が必要(slopes.railEdgeContinuous を
  深さオフセット付きで流用できるはず)
- 地形編集(盛土/切土)は地下線路のあるセルもブロック対象に追加すること
  (相対深さが地表に追従するため、地表を変えると地下の連続性が壊れる)
- 列車の隠蔽描画は「選択表示レベルと列車のレベルが一致するか」で決める
  (トンネルの isTrainHiddenInTunnel とは独立の機構)

## P8a実装メモ(sim層のみ、0.3.0-Alpha-39bベース)

- **型の一般化**: `types.ts`に`Level = -3|-2|-1|1|2|3`を新設し、`CellData.uppers`の
  キー型・`StationData.cells[].layer`をこれへwideningした(識別子`uppers`は
  そのまま維持。地下も同じ辞書に負キーで載る)。`pathfinding.ts`の`Layer`・
  `reservation.ts`の`Grid.layer`・`simulation.ts`の内部`Grid.layer`も同様に
  widening。ramp.baseは元々`number`型だったため変更不要(負のbaseは既に
  型上は許容されていた)。construction.tsには`ElevatedLevel(=1|2|3)`と対称の
  `UndergroundLevel(=-1|-2|-3)`を新設し、`ALL_LEVELS`(uppers走査用の
  `[1,2,3,-1,-2,-3]`)を追加した。
- **pickElevatedConnection/planElevatedPathの符号対称化**: 「M(接続先の既存
  レベル)がlevelより地表から遠いか」でアンカーの要否を決める(`level===0`は
  常にアンカー、`level>0`は`M>level`、`level<0`は`M<level`)よう修正した。
  素朴に「生の数値比較`end.level>level`のまま」だと、level<0の非0ケースで
  非対称になるバグがあった(construction.test.tsに詳しいコメント付きで記録)。
  一方`assignRampZone`のbase/ascending割り当て(near/farのlocal level 1/2、
  baseの並び)は、M/levelの生の大小関係(`connectLevel<level`)を使う既存実装の
  ままで符号に関わらず正しいことを確認した(変更不要)。
  - **符号反転による素朴な鏡映テストは成立しない**: 「正レベルの入力を全部
    符号反転すれば結果も符号反転するはず」という直感的なテストは、
    `M<level`の大小関係が符号反転で反転する(例: `1<2`だが`-1>-2`)ため
    成立しない(near/far割り当てが変わってしまう)。construction.test.tsでは
    「null/non-nullとrole種別ごとの個数」という符号に関わらず不変な性質だけを
    対称性として検証している。
- **undergroundEdgeContinuous(slopes.ts)**: design docの「相対深さ方式」により
  深さkは連続性条件から相殺で消えるため、実装は「両セルとも地表がflatで
  railEdgeContinuousが真」の合成になった(depth引数は型合わせのため残すが
  未使用)。地下はこのバージョンでは地表がinclineなセルの下には通せない
  (design doc本文にも明記済みの制約)。
- **applyUndergroundPath/applyUndergroundStation(construction.ts)**:
  applyElevatedPath/Stationと同じプランナー(resolveElevatedPathEnd/
  pickElevatedConnection/planElevatedPath)を再利用する新規関数として追加した
  (levelの符号だけが違うのでapplyElevatedStationの本体は`applyLayeredStation`
  へ共通化し、両関数はその薄いラッパーにした)。地下線特有の相違点:
  町タイルは無視・水域下は禁止・坂だけでなく地下線(span)自体も地表flat限定・
  地下線どうしの隣接はundergroundEdgeContinuousで検査・既存の地平/高架とは
  常に共存(地平のconnectionsを一切書き換えない)。
- **地平↔地下ランプのpathfindingバグ**: `pickElevatedConnection`/
  `planElevatedPath`は正しく地下対応できていたが、実際に統合テスト
  (underground-integration.test.ts)を書いて初めて、地平(0)から
  base=-1の掘割ランプへ接続する経路で列車が発車すらできない
  (`resolveEntryLayer`が「今いる層のconnections/uppersしか見ない」ため、
  ランプセルの接続ビットがuppers[-1]だけに書かれると地平側から先へ進めない)
  欠陥が発覚した。elevated(base===0)の場合は`orIntoBaseLevel`がconnections
  へ書くために自然に動いていたが、地下(base===-1、地平0への掘割)はそうならない。
  修正: base===-1のランプセルは、connectionsにもuppers[-1]と同じビットを
  重ねて持たせる(ramp.base自体は-1のまま。rendering/層遷移のadjacency判定
  (`rampBaseOf===min(現在層,次の層)`)には影響しない)。**教訓**: 高架と
  地下の「符号対称」は型・プランナーレベルでは成立していても、pathfinding/
  reservationの実装が暗黙に「base=0はconnections」という非対称な前提を
  1箇所に持っていると、実際に列車を走らせるテストを書くまで気づけない。
  設計を鏡映しただけでは不十分で、末端の統合テスト(departure→arrival)が
  最終的な検証として必須だった。
- **コスト(economy.ts/buildPreview.ts)**: `UNDERGROUND_RAIL_COST_MULTIPLIER=6`・
  `UNDERGROUND_STATION_COST_MULTIPLIER=3`・`costOfUndergroundPath`・
  `UNDERGROUND_STATION_COST(=ELEVATED_STATION_COST×3)`をdesign doc通りに追加し、
  `evaluateBuild`のlevel<0分岐から配線した。elevatedと異なり、地下は坂/地下線を
  区別せず経路の全セルに同じ倍率を課す(設計をそのまま反映した単純化)。
- **地形編集ブロック(terrainOverlay.ts)**: `buildEditBlockers`は変更不要だった。
  `applyUndergroundPath`が地下専用セルでも`railMap.set(key,{type:'rail',...})`
  として登録するため、既存の`railMap.has(x,z)`チェックだけで「地下線があるセル
  は地形編集をブロックする」が自動的に成立する(テストで確認)。
- **永続化(persistence.ts)**: **v15のまま据え置き**。`CellData.uppers`/
  `ramp.base`/`StationData.cells[].layer`の型wideningはTypeScriptの型のみの
  変更で、実行時の形(数値キーを持つ素朴なオブジェクト・普通のnumber)は一切
  変わっていないため、シリアライズ形式は追加互換になる(ラウンドトリップ
  テストで確認)。バージョンを上げる理由が無かった。
- **テスト一覧(新規/大幅追加ファイル)**: `construction.test.ts`(符号対称性・
  applyUndergroundPath/Station)・`slopes.test.ts`(undergroundEdgeContinuous)・
  `buildPreview.test.ts`(地下のコスト・no-effect)・`terrainOverlay.test.ts`
  (地下セルのブロック確認)・`persistence.test.ts`(地下のラウンドトリップ)・
  `underground-integration.test.ts`(新規ファイル。車庫→掘割→地下線→地下駅の
  走行、地上+地下の同一駅ID統合)。
- **やらなかったこと(P8b/c送り)**: 描画(地下ビュー切替・掘割の開口部表現)・
  UIのレベル選択(ArrowUp/Downの負方向拡張、現状は`stepElevatedLevel`が0..3
  固定のままGameUI.tsxでキャストして型だけ通した)。

## P8b-c実装メモ(0.3.0-Alpha-39b→40aベース)

- **UI(レベル選択、GameUI.tsx/trackPath.ts)**: `stepElevatedLevel`を
  `0|1|2|3`から`-3..3`(新設の`Level3`型)へ拡張した。0をまたぐ特別扱いは無く、
  単純な加算+クランプのまま(対称性のおかげで場合分けが要らない)。ツールバーの
  建設レベル選択は`-MAX_ELEVATED_LEVEL..MAX_ELEVATED_LEVEL`の7ボタンになり、
  負レベルは「地下1」〜「地下3」表記(高架の「Lv1」〜と対比、色もT.accent系に
  差別化)。ボタンのtitleと線路/駅ツールのhintに、地下のコスト
  (`UNDERGROUND_RAIL_COST_MULTIPLIER`倍・`UNDERGROUND_STATION_COST`)を明示した。
- **建設コミット配線(useGameLogic.ts)**: `commitPath`のrail/stationケースを
  `level===0 / level>0 / level<0`の3分岐にし、`level<0`側を
  `applyUndergroundPath`/`applyUndergroundStation`+
  `costOfUndergroundPath`/`UNDERGROUND_STATION_COST`へ配線した(elevated側の
  配線と対称。プレビュー(buildPreview.ts)は既にP8aで配線済みだったので変更不要)。
- **プレビュー(GameScene.tsx)**: `elevatedPreviewPlan`の`level`引数の型を
  `ElevatedLevel`から`BuildLevel`へ広げただけで、地下のプレビュー計画
  (坂/spanの色分け・高さ)もそのまま動く(`pickElevatedConnection`/
  `planElevatedPath`がP8aで既に符号対称に作られていたため)。
- **地下ビューの表示メカニズム(方針)**: 「カットアウェイ無し」の設計方針どおり、
  地下モードでは地表・高架・(選択中以外の)地下をまとめて暗く半透明にし、
  選択中の地下レベルだけ通常輝度で描く。実装は**マテリアルの共有インスタンスを
  2セット(`render/palette.ts`の`MATERIALS`/`DIMMED_MATERIALS`)用意し、
  メッシュ単位でどちらを参照するか選ぶだけ**にした(メッシュごとのクローン生成は
  しない、というタスクの制約どおり)。`DIMMED_MATERIALS`は`MATERIALS`と同じキー
  構成を持つ「transparent+opacity低めの色」の別インスタンド集合。
  `materialsFor(dimmed)`ヘルパーがその選択を1箇所に集約する。可視性・明暗の
  判定ロジック自体は`render/viewMode.ts`の3つの純関数(`isUndergroundView`/
  `shouldRenderLevel`/`isLevelDimmed`)に切り出し、TDDでテストしてから各描画
  コンポーネントへ配線した(判定を各コンポーネントに書き写さない)。
  - `TerrainBlocks`/`Scenery`/`TownBlocks`/`StationBlock`/`TrainCar`は
    `dimmed?: boolean`propを追加しただけ(地表・高架・地平駅・地上/高架列車は
    地下ビュー全体でひとまとめに暗くなる/明るいままかの二値)。
  - `TrackNetwork`は地下(uppers[-1..-3]・ramp.base<0)の描画を新規に追加した。
    地平・高架は従来通り1つの「surface」バケットにまとめ、地下ビュー時は
    `materialsFor(undergroundView)`で丸ごと暗くする。地下は「選択中のレベルと
    一致する分(bright)」「それ以外の地下(dim)」の2バケットに分け、通常表示
    (`!undergroundView`)では両方とも描かない(掘割の開口だけ出す、後述)。
    地下の坂・span(桁)は土中なので支柱・桁・バラスト(ramp本体を除く)を
    描かない(高架のような橋脚は要らない)。
  - `DynamicTrain`/`TrainCar`は列車ごとに`dimmed`を1つ算出し(選択中レベルと
    その列車の層が一致するか)、`TrainCar`へpropとして渡す。共有材質
    `bodyMaterialDimmed`(車体色ごとにキャッシュ、`bodyMaterial`の暗い版)を
    新設した。
- **掘割ランプの地表開口(TrackNetwork.tsx/render/trackGeometry.ts)**: 通常表示
  (地下ビューでない)では地下線そのものは完全に隠すが、ランプの浅い側
  (`ramp.base===-1`、地表に接する側)のセルだけ`buildUndergroundOpeningPart`
  (暗いpitの床+左右の擁壁、いずれもBoxGeometry)を出す。地下ビュー中はこの
  セルも他の地下と同様bright/dimどちらかの通常線路として描く(開口とは排他)。
- **列車の層判定はrenderPos.yからの逆算をやめた(重要なバグ修正)**: 当初
  `DynamicTrain`で`Math.round(head.y / OVERPASS_HEIGHT)`から層を復元しようと
  したが、これは誤り。地下は「地表からの相対深さ」なので、丘の上(標高h>0)の
  地下1段はrenderPos.yが`0.5 + h*OVERPASS_HEIGHT - 1*OVERPASS_HEIGHT`になり、
  平地の地下1段(`0.5 - 1*OVERPASS_HEIGHT`)と式が一致しない(hに依存して
  ずれる)。丘の上では「地下にいるのに地平/高架と誤判定される」バグになる。
  正しい修正は、sim側が最初から持っている真の層(`TrainRuntime.grid.layer`、
  sim/pathfinding.tsの`Layer`)をそのまま読むこと。DynamicTrainはこれに
  差し替えた。
- **もう1つのバグ: consist.tsのtrackCentreHeightが地下の非rampセルを常に
  平地(0.5)扱いしていた**: 2両目以降の描画高さを求める`carPositions`
  (sim/consist.ts)の内部関数`trackCentreHeight`は、高架(`layer>0`)は
  早期returnで扱う一方、地下(`layer<0`)の分岐が無く、ramp以外の地下spanセルは
  「地形追従の地平セル」と同じ扱いにフォールバックしていた。地表の標高が0の
  平地ではたまたま偶然近い値になるが、丘の上では大きくずれ、2両目が先頭と
  違う高さに描かれる(編成がガクガクになる)不具合があった。
  `simulation.ts`の`cellRampHeight`と同じ式(`0.5 + 地表高さ + layer*OVERPASS_HEIGHT`、
  layerは負なので実質減算)を移植して修正した。TDD: 丘(標高2)と平地それぞれで
  2両編成を組み、2両目の高さが期待値と一致することをテストした
  (`src/sim/consist.test.ts`)。
- **テスト一覧(新規)**: `src/render/viewMode.test.ts`(可視性・明暗の純関数)・
  `src/render/trackGeometry.test.ts`に`buildUndergroundOpeningPart`のケースを
  追加・`src/sim/trackPath.test.ts`の`stepElevatedLevel`を負レベルまで拡張・
  `src/sim/consist.test.ts`に地下(layer<0)の描画高さのケースを追加。
- **ブラウザ検証(port 5175)の要点と制約**: デバッグシナリオ「坂・高架・往復
  列車」を読み込み、線路ツール→↓キー(または「地下1」ボタン)で地下ビューに
  入ると、地表・既存の高架・線路がまとめて暗く半透明になることを確認した。
  レベル選択の日本語ラベル(地下1〜3、地平、Lv1〜3)・ツールのhint文言も
  想定通り表示された。ブラウザの`left_click_drag`ツールは本アプリの
  pointerdown/pointermove/pointerupシーケンスを安定して再現できず(1マスの
  no-effect判定になることが多かった)、`javascript_tool`でcanvasへ
  `PointerEvent`を直接複数回dispatchするドラッグシミュレーションに切り替えた
  ところ、地下線(`uppers[-1]`)の実際の建設(コストは`RAIL_COST×6`どおり)を
  確認できた。カメラの右ボタンパン操作も自動化ツールから安定して再現できず、
  掘割の開口部の見た目・地下駅→列車走行までの一気通貫の目視確認は今回は
  行えていない(単体テスト・型検査・状態確認(`window.__debugWorld`)で
  代替した)。次回ブラウザ検証時は、OrbitControlsのref経由でカメラ位置を
  直接動かすデバッグフック(`window.__dbgSetCamera`等)を用意すると安定する。

## P8b可視性バグ修正メモ(0.3.0-Alpha-40a→40b)

- **症状**: 親エージェントの実機検証で発覚。地下1を選択して地下線を建設すると、
  `window.__debugWorld`上はuppers[-1]が正しく作られ課金(¥6,000/10マス)も正しいのに、
  画面上には何も見えない(地表の半透明メッシュが実質不透明に見え、下の地下線を
  隠してしまう)。
- **調査**: `window.__camera`/`window.__orbitControls`をGameScene.tsxのrefから
  一時的に(恒久的に、`window.__sun`と同じ慣行として)公開し、`scene.traverse`で
  実際のメッシュの`visible`/`material.opacity`/`material.transparent`/
  `material.depthWrite`/`renderOrder`/ジオメトリの実頂点座標を直接確認した。
  地下線メッシュ自体は正しい位置(`uppers[-1]`のセルに対応する世界座標)に
  存在し、`visible:true`・`opacity:1`(不透明)であることを確認。地表(草地・
  地面プレーン)も`transparent:true, opacity:0.3, depthWrite:false`(最初の修正
  コミットで入れた設定)になっていることを確認できたが、それでも画面には
  何も表示されなかった。地表メッシュを`visible:false`にすると地下線が正しい
  位置に出現することから、「メッシュは存在するが地表の半透明レイヤーに
  隠されている」ことを確定させた。
- **根本原因**: `depthWrite:false`だけでは不十分で、`depthTest`が既定の`true`の
  ままだと、この地下ビューの構図では地表の半透明フラグメントが(本アプリの
  `OrthographicCamera`が`near=-50`という非標準値を使っている影響と推測される)
  深度テストで正しく可視と判定されず、結果的に何も描かれない(=地表色も
  地下線の色も出ない)現象が起きていた。`scene.traverse`で対象マテリアルの
  `depthTest`を`false`に変更した瞬間、画面に地下線が正しく透けて見えるように
  なることを実機で確認し、これを恒久修正としてソースに反映した
  (`render/palette.ts`の`dim()`ヘルパーに`depthTest: false`を追加、
  `GameScene.tsx`の地面プレーン用インラインマテリアルにも
  `depthTest={!undergroundView}`を追加)。
- **renderOrder**: 上記のdepthTest修正だけで可視性バグ自体は解消したが、
  親エージェントの指摘どおり「不透明/半透明キューの並びに頼らない」ことを
  明示するため、`render/viewMode.ts`に`SURFACE_RENDER_ORDER=0`/
  `UNDERGROUND_RENDER_ORDER=10`を追加し、TrackNetwork/TerrainBlocks/
  TownBlocks/Scenery/StationBlock(useEffect+group.traverseでmesh一括設定)/
  DynamicTrain(視認層が変わった時だけtraverse)に配線した。three.jsの仕様上、
  不透明(opaque)と半透明(transparent)は描画パスそのものが分かれており
  opaqueが必ず先に描かれるため、renderOrder単体では今回のバグは解決しない
  (実際に検証済み)が、同じキュー内での並び順の意図を明示するため残す。
- **デバッグ手法として得た知見**: ブラウザの`left_click_drag`(computerツール)は
  この環境で不安定(hoverしても1マスのno-effectに落ちることが多い)。
  `javascript_tool`でcanvasへ`PointerEvent`(pointerdown→複数pointermove→
  pointerup)を直接dispatchする方式は安定して再現できた。ただし
  **座標系に注意**: `javascript_tool`はDOM実ピクセル空間(このアプリでは
  1280x720)で座標を渡す必要があるのに対し、`computer`ツール(screenshot/
  hover/left_click_drag)はスクリーンショット表示空間(800x450、内部で
  自動的に実ピクセルへ変換される)を使う。混同すると数百px単位でずれる。
  カメラの位置を直接確認・移動したい場合は、`OrthographicCamera`/
  `OrbitControls`のrefをコンポーネント側で`window`に公開しておき
  (`window.__camera`/`window.__orbitControls`、`window.__sun`と同じ慣行)、
  `controls.target.set(x,y,z); controls.update();`で移動するのが安定する
  (`camera.position`を直接書き換えてもOrbitControlsの次回updateで元に
  戻される)。ワールド座標→スクリーン座標の変換は自前で行列計算するより
  `THREE.Vector3.prototype.project(camera)`(cameraの既存インスタンスの
  コンストラクタから`Vector3`を取得できる: `camera.position.constructor`)を
  使うほうが確実。

## P8b-c可視性バグ再修正メモ(0.3.0-Alpha-40b→40c): opacity 0でも足りなかった

- **症状**: 上記40bの修正(depthTest追加)後も、実機再検証で地下線が依然として
  見えないケースが再現した。地面プレーン単体を`visible:false`にすると地下線は
  正しく見えるが、`transparent:true, opacity:0`(色を出さずに`visible:true`のまま
  ピッキングだけ残す案)にすると再び見えなくなる。
- **根本原因**: `depthTest:false`のオブジェクトはZバッファを無視して「描画された
  順序」だけで上書きされる。地面プレーン(renderOrder=0)はopaque級の地下線
  (renderOrder=10, `transparent:false`)より先に描かれるが、その後に描かれる
  TerrainBlocks/Scenery/TownBlocksの`DIMMED_MATERIALS`(地下ビュー中はこれらも
  `opacity:0.3, depthWrite:false, depthTest:false`)が多数積み重なって地下線の
  上からアルファブレンドされる。理論上`opacity:0`ならブレンド結果は無変化の
  はずだが、実機では地面プレーンを含めた半透明キュー全体の重なりが「地下線を
  隠す」方向に働き、地面プレーンだけ`opacity:0`にしても解消しなかった
  (この経路の正確な原因はブレンド式やドライバ依存の挙動まで追い切れていない。
  再現条件は実機検証で確定させたが、理論的な完全解明はしていない)。
- **修正**: 地面プレーンのマテリアルに`colorWrite:false`(地下ビュー中のみ)を
  追加し、`transparent`/`opacity`はいじらないことにした。`colorWrite:false`は
  フレームバッファへの色出力そのものを止めるため、上記のブレンド経路に一切
  乗らない。レイキャスト(ポインタピッキング)はCPU側のジオメトリ交差判定で
  `visible:true`であれば効くため、`colorWrite:false`でも建設ドラッグ等の
  操作性は維持される。`GameScene.tsx`の地面プレーン用マテリアルを参照。
- **検証手法の教訓**: `left_click_drag`(computerツール)は本アプリでは
  ほぼ確実にドラッグとして成立しない(pointerdownとpointerupの間の
  pointermoveが飛ばないためコード側のセル差分検知が働かない)。
  `javascript_tool`でcanvasへ`pointerdown`→`pointermove`(複数)→`pointerup`を
  直接dispatchする方式のみが安定して再現できた。この方式で地下1に
  線路を敷設し、`window.__debugWorld.railMap`のセルに`uppers["-1"]`が
  乗ることを確認してから見た目を検証する。

## 0.5.0-Alpha-4c: 地下まわり3件のバグ修正(ユーザー報告「地下周りの動きが怪しい」)

報告は「建設できるのに建設できないって表示される」「地上レイヤーに移動すると、
地下にだけある駅の表示が完全に消滅する」の2点。調査の結果、独立した3件の欠陥だった。

### (A) 1マスホバー中の「ここには建設できません」誤表示

- **症状**: 地下(および高架)の線路ツールを選ぶと、マウスを動かしているだけで
  常時「ここには建設できません」が出る。実際にはそこから2マス以上ドラッグすれば
  問題なく敷ける。建設直後もプレビューが1マスに戻るため、成功した直後に
  「建設できません」が表示される。
- **根本原因**: `applyElevatedPath`/`applyUndergroundPath`は`path.length < 2`を
  no-opにする。プレビュー(`evaluateBuild`)はapply系の「変化が無ければ同一参照」で
  可否を判定するので、ドラッグ前の1マス経路が「その場所が建設不可」と同じ
  `'no-effect'`に落ちていた。
- **修正**: 最小経路長を`construction.LAYERED_RAIL_MIN_PATH_CELLS`として公開し、
  apply系とプレビューが同じ定数を見るようにしたうえで、プレビューに
  `'incomplete-path'`を新設(GameUIは控えめな色で「ドラッグして2マス以上の経路を
  指定してください」と案内する)。
- **プレビューと実建設の判定ズレは他に無いことを機械的に確認した**:
  `src/sim/previewCommitParity.test.ts`(新規)が、乱数で作った4000本の経路を
  `evaluateBuild`と「useGameLogic.commitPathの手順の写し」の両方へ通し、
  「okかどうか」と「実際に建設できたか」・コストの一致を検査する
  (地平/高架/地下・線路/駅/車庫/信号/撤去、駅の軸ヒント込み)。現状ミスマッチ0。

### (B) 地上ビューで地下だけの駅・路線が完全に消える

- **経緯の訂正**: これはR4(three.js退役)の回帰ではない。P8bの設計判断
  (本ファイル上部の「3. 描画は地下ビュー切替」)そのままに、退役前のthree.js実装でも
  地上ビューでは地下線・地下ホームを一切描いていなかった(掘割の開口だけ)。
  `DIMMED_MATERIALS`(opacity 0.3)は「地下ビュー中に地表側を暗くする」ための材質で、
  地下を地上ビューへ透かすためのものではない。つまり仕様どおりの挙動だったが、
  地下だけの駅は駅舎もラベルも出ないため**盤上から完全に見失う**という実害があり、
  設計を変更した。
- **変更後の規則**: 地上ビューでは地下の線路・ホームを**ゴースト(不透明度0.3)**で
  地形の上に重ねる。地下ビュー中のbright/dimの挙動は変更しない。
  判定は`render/viewMode.ts`の`undergroundBucketOf(level, undergroundView, selectedLevel)`
  →`'bright'|'dim'|'ghost'`へ集約した(旧`shouldRenderLevel`は本変更で意味を失ったので削除)。
- **駅名ラベル**: `computeStationHousePlacement`は完全地下駅の地上ビューで`null`を
  返していたため、駅舎だけでなくラベル(GameLabelsがこの配置を使う)も消えていた。
  `houseHidden`フラグへ置き換え、配置は常に返す(駅舎は出さない/ラベルは出す)。
- **地下の列車は地上ビューでは非表示のまま(パリティ判断)**: インスタンス描画の
  シェーダは頂点色のαを「路線色の重み」として使い切っており、αブレンドで薄くする
  経路が無い(WGSL変更が必要)。退役前のthree.jsでも地下の列車は不透明な地形に
  遮られて実質見えなかったため、見た目の互換としても後退にはならない。
  選択中の列車のDOMツールチップは地上ビューでも出るので追跡はできる。

### (C) 地下線を走る列車の層タグが落ちて地平扱いになる

- **症状**: 地下駅に着いた列車が地表の高さに描かれる。地下線の上を「地表を走って
  いる」状態で走る(掘割で一度沈んでからすぐ地表高さへ戻る)。
- **根本原因**: `pathfinding.ts`のBFSが経路セルへ層タグを付ける条件が`layer > 0`
  で、地下(負レベル)のときだけ`undefined`(=地平)になっていた。高架しか無かった
  頃の条件がそのまま残っていたもので、`extendThroughPlatform`側では以前に
  `layer !== 0`へ直されていたが(216-219行のコメント)、BFSの2箇所が直し漏れていた。
- **影響**: 描画高さだけでなく、予約キー(`reservationKey`)も地平と同じになるため、
  同じ(x,z)の地平線路と地下線路が互いをブロックし得た。
- **修正**: 2箇所とも`layer !== 0`に統一。回帰テストを
  `underground-integration.test.ts`に追加(地下区間走行中の`grid.layer===-1`と
  描画高さが地表より下であることを確認)。

## 0.5.0-Alpha-4d: 地下ビューで地下駅がクリックできない問題を修正(0.5.0-Alpha-4cの積み残し)

### 症状

地下ビュー中に地下駅セルをクリックしても、駅パネルが開かない(選択できない)。
選択中の列車がスケジュール編集中でも、地下駅をスケジュールへ追加できない。

### 根本原因

`GameScene.tsx`の`handleClick`は地平駅セル(`pos`そのもの)と高架駅セル
(`elevatedCellCandidateFromGroundClick`で候補を逆算)しか解決しておらず、
地下駅セルの解決経路が無かった。0.5.0-Alpha-4cで地下のゴースト描画・地下ビューの
bright/dim表示は直したが、クリック解決はP8b以来一度も地下に対応していなかった
(高架だけが特別扱いされていた)。

### 修正

- `render/stationLayers.ts`に`undergroundCellCandidateFromGroundClick(pos, level)`を
  追加。`elevatedCellCandidateFromGroundClick`と全く同じ幾何(候補=クリック位置+
  見えている高さ)を、地下レベルの負の高さ(`level*OVERPASS_HEIGHT`)へそのまま
  適用するだけ(符号が変わるだけで式は共通)。
- `undergroundLevelSearchOrder(selectedLevel)`で、地下ビュー中に「今見ている深さ」
  (`buildLevel`)を最優先にした探索順(例: 選択中が-2なら`[-2,-1,-3]`)を返す。
  複数の地下レベルが同一(x,z)に重なる可能性があるため、選択中の層を優先して誤爆を
  減らす。
- `GameScene.handleClick`は`undergroundView`のときだけこの新しい経路を使い、
  地上ビュー(既存の高架候補ロジック)には触れていない。スケジュール追加
  (`onAddSchedule`)・駅選択(`onSelectStation`)のどちらも、既存の地平/高架と
  同じ分岐構造(選択中の列車があればスケジュールへ、無ければ駅パネルを開く)で
  地下駅IDを流し込むだけ。

### 地上ビューでの地下駅ゴーストクリックは対象外(意図的なスコープ限定)

地上ビューで地下駅のゴースト越しにクリックして選択できると便利ではあるが、
ゴーストは地表のコンテンツ(線路・建物・地形)の下に重なって見えるため、
地表側のクリック解決との優先順位付けが本質的に曖昧になる。今回のバグ報告と
検証要件は「地下ビューで地下駅を選べない」ことなので、地上ビューのクリック解決は
既存のまま(地平→高架のみ)変更していない。地下だけの駅を見失わないための救済は
0.5.0-Alpha-4cの駅名ラベル常時表示(houseHidden)で足りている、という判断。

### 検証

- `render/stationLayers.test.ts`に`undergroundCellCandidateFromGroundClick`/
  `undergroundLevelSearchOrder`のテストを追加(TDD)。
- ブラウザ実機: 地下1に線路+駅を建設→地下ビューへ切替→駅クリックで駅パネルが
  開くことを確認。列車を購入し運行表編集モードで同じ駅をクリック→運行表に
  追加されることを確認。地平駅・高架駅のクリック(選択・運行表追加)が
  引き続き問題なく動くことも確認(既存経路は変更していないが回帰確認として)。

## 掘割ランプ(base<0)のdirが逆向きで線路が寸断される不具合(0.5.0-Alpha-8b)

### 症状

地下ビューで、地平の線路端から地下線へ自動接続した掘割ランプ(`ramp.base<0`)が
連続した坂に見えず、2セル分がバラバラの短い破片として表示され、隣接セル境界は
おろか地平側・地下側の線路とも高さが繋がっていなかった。高架(`base>=0`)の坂は
問題なく、地下(`base<0`)だけで再現した。

### 原因

`rampDirResolver`(construction.ts)が返す`dir`は、`buildRampTrackParts`
(render/trackGeometry.ts)側で「高さの高い側」(`rampHeightAtPos`がposHighに
近いほど高い)として解釈される契約になっている。高架(base>=0)ではこの契約が
自然に成り立つ: 経路内側(アンカーの反対、あるいはアンカーそのもの)へ向かう方向は
常に高さが上がる方向と一致する。

しかし地下(base<0)では高さの高低が反転する。掘割の「高さの高い側」は地表(0)に
近い側=`base+1`側であり、これは`rampDirResolver`が「経路内側」として返す方向とは
逆になる場合がある(地平の自由端から地下線へ直接繋ぐケースも、地下線同士がさらに
深いレベルへアンカー接続するケースも同様)。結果として、`ramp.dir`が実際の高さ勾配
とは逆向きに割り当てられ、`buildRampTrackParts`が生成する縦断プロファイルが
セル境界・隣接セル・地平/地下双方の線路と食い違っていた。

### 修正

`applyGroundPathWithElevatedConnect`と`applyUndergroundPath`(construction.ts)の
両方で、`ramp.base < 0`のときだけ`rampDirFor()`の結果を`getOppositeDir()`で
反転させてから`ramp.dir`に格納するようにした。`buildRampTrackParts`側(レンダラー・
sim双方が参照する`rampHeightAtPos`の契約)は変更していない。`applyElevatedPath`
(高架専用、level>=1のみでconnectLevelも常に0以上)はbase<0を生成しないため対象外。

### 検証

- `construction.test.ts`に、地平の自由端から`applyUndergroundPath`で直接繋いだ
  掘割ランプの`ramp.dir`が高さの高い側(地表寄り)を向くことを検証するテストを
  追加(修正前は逆向き=Redを確認済み)。
- ブラウザ実機: 地平に線路を敷設→地下1へ切替→その端からドラッグして自動接続の
  掘割ランプを作成→地下ビュー・地上ビュー(ゴースト)の両方で、連続した1本の
  坂として地平〜地下が繋がって見えることを確認(修正前は寸断、修正後は連続)。

## 0.5.0-Alpha-8e: 地上ビューの地下線ゴーストを廃止(線路のみ完全非表示)

### 背景

0.5.0-Alpha-4cで「地下にしかない駅が地上ビューで見つからない」問題を解決するため、
地上ビューでも地下の線路・駅を半透明のゴースト(地形の上へ薄く重ねる表示)として
出すようにした。ユーザーから「地上ビューの地下線ゴーストがごちゃごちゃして見づらい」
とのフィードバックがあり、以下の要件で見直した。

- 地上ビュー: 通常の地下線路(および地下ランプ`base<0`の坂の線路部分)は一切描かない。
- 地上ビュー: 地下駅のホーム(ゴースト)・駅名ラベルは従来どおり表示する
  (Alpha-4cの発見容易性維持)。
- 地下ビュー(bright/dim)の挙動は無変更。
- 掘割の地表開口(pit/wall、地表の構造物)は地上ビューで従来どおり表示する
  (線路そのものではないため対象外)。

### 実装

決定点は`render/viewMode.ts`の`undergroundBucketOf`(このファイルのコメントが
明記するとおり、コンポーネント側は個々に条件を書き写さず、この純関数の判定結果に
従うだけ、という既存方針)。`UndergroundBucket`型を`'bright' | 'dim' | 'ghost'`から
`'bright' | 'dim' | 'hidden'`へ変更し、地上ビュー(`!undergroundView`)では`'hidden'`
を返すようにした。

`undergroundBucketOf`の呼び出し元は`render/railGeometry.ts`の`buildRailNetworkGeometry`
だけ(駅ホームは`components/WebGpuStations.tsx`側の独立した経路で、この関数を経由
しない)なので、この変更は線路の可視性だけに影響し、駅のゴースト表示・ラベルは
無変更のまま保たれる。`railGeometry.ts`の`bucketOf`は`'hidden'`のとき`null`を返し、
呼び出し側は`bucket`が非nullのときだけジオメトリを積むよう変更した。掘割の開口
(pit/wall)は元々`!undergroundView`の条件だけで出しており、線路のバケット判定とは
独立していたコードだったため、開口の可視性は無変更。

不要になった`RailNetworkGeometry.undergroundGhost`フィールド・
`WebGpuTrackNetwork.tsx`のゴーストメッシュチャンクフィーダ・
`MESH_CHUNK_NAMESPACE.railUndergroundGhost`は削除した(死んだコードを残さない)。

### 検証

- TDD: `viewMode.test.ts`の該当ケースを`'ghost'`→`'hidden'`の期待値に更新して
  Red→Green。`railGeometry.test.ts`も、地上ビューでの地下線ジオメトリが
  (undergroundBright/undergroundDimのどちらにも)一切現れないことを検証するよう
  更新した。
- ブラウザ実機: 地下1に線路(掘割ランプ経由)+地下駅を敷設し、(1)地下ビューで
  選択中レベルの線路・駅ホームが通常どおり明るく表示されること、(2)地上ビューへ
  切り替えると線路(ランプ含む)は完全に消え、地下駅のゴースト(半透明の箱)と
  駅名ラベル("南浜駅 0人")だけが残ることを確認。
