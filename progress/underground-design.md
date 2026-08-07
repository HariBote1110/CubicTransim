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
