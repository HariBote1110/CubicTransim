# 駅テンプレート建設ツールのUI・描画

## 決定
- `BuildMode`(GameUI.tsx)に`'template'`を追加し、ショートカット`8`を割り当てた。回転は
  `R`キーで`quarterTurns`を0→1→2→3→0と一周させる(`src/ui/templateRotation.ts`の
  `cycleQuarterTurns`、純粋関数として切り出しテスト済み)。
- テンプレートの選択・向きの状態(`selectedTemplateId`/`quarterTurns`)はApp.tsxに置き、
  GameUI(選択UI・Rキー・バナー)とGameScene(プレビュー・設置)の双方へpropsで渡す。
  buildModeやpreviewPathと同じ配置方針に合わせた。
- 設置はドラッグではなくクリック1回。GameScene.handleClickで`buildMode==='template'`を
  最優先に分岐し、`onCommitTemplate(pos)`を呼ぶ。handlePointerDown/Upの汎用ドラッグ経路
  (`dragStartPos`)はtemplateモードでは早期returnして素通りさせ、既存のrail/station等の
  ドラッグ確定ロジックと衝突しないようにした。
- 会計処理は`useGameLogic.commitTemplate`が担う。`commitPath`と同じ形(sim層の
  `evaluateStationTemplate`で可否・コストを問い合わせ→`ok`のときだけ`applyStationTemplate`を
  適用→resultの参照が変わっていたときだけ課金・ledger記録)。UIに条件を書き写さない方針
  (CLAUDE.md)を維持するため、GameUI側のバナーもGameScene側のプレビュー色も両方
  `evaluateStationTemplate`を呼んで判定する(二重実装だが、どちらも「実際に適用してみる」
  同じ関数を呼んでいるだけなのでロジックの重複ではない)。
- プレビュー描画は`templateAbsoluteCells`が返すセル列をそのまま使い、`kind`で色分け
  (駅セル=station色、railセル=accent色)。設置不可(no-effect/資金不足)のときは全セルを
  警告色(REMOVE_COLOUR)に統一する。既存の`previewPath`ベースの汎用プレビューは
  buildMode==='template'のときレンダリングを止め、テンプレ専用の`templatePreview`に
  置き換えた(previewPath自体はGameUIのバナー用にアンカー1点だけを流す)。

## 実機確認結果(Browserツール)
- 十字テンプレをクリック1回で設置 → `railMap`に9セル、`stations`に1件(cells.length===9)。
- 別の場所でRキーを1回押してから設置 → 同じく9セルの新しい駅として登録(十字は回転対称
  なので見た目・セル数とも同一になることを確認)。
- 相対式2面2線テンプレを既存の十字駅の隣に設置 → `applyStation`の交差統合により
  既存駅とマージされ、9セル→17セルの1つの駅になった(想定通り、テンプレ側で交差統合を
  重複実装していない)。
- 資金不足・重複設置(既存駅の真上にカーソルがある状態)では、バナーが
  「駅テンプレ ここには建設できません」に変わり、クリックしても`railMap`/`money`が変化
  しないことを確認。
- 十字駅の描画(ホーム・上屋)は交差セルでも破綻せず、既存の`StationBlock`が
  `connections`から屋根・柱を組み立てる実装のままで問題なかった。描画側の追加調整は不要。

## 既知の制約(解消済み)
- ~~テンプレート設置時、`commitPath`の駅ケースにある「近くに町が無ければ一定確率で新しい
  町を湧かせる」(`maybeSpawnTownForStation`)処理は移植していない。~~
  → `sim/towns.ts`に`resolveTownSpawnForStation`を切り出し(`maybeSpawnTownForStation`を
  1回だけ呼び、命名用のtowns配列を返すラッパー)、`commitPath`・`commitTemplate`の両方から
  同じ関数を呼ぶ形にした。テンプレートはアンカー座標を基準に1回だけ判定するため、セル数ぶん
  何度も抽選することはない。駅名は判定→townsForNamingを確定させてからapplyStation/
  applyStationTemplateに渡す順序なので、湧いた町の名前がそのまま駅名に反映される
  (テンプレも通常駅と同じ処理順で、駅名がA駅のまま取り残される不整合はない)。
  テストは`src/sim/towns.test.ts`の`resolveTownSpawnForStation`にRed→Greenで追加。

## 追記(2026-07-28 free-elevated-track)
駅テンプレート機能(sim/stationTemplates.ts、本UIが依存していたapplyStationTemplate/STATION_TEMPLATES)はユーザー判断により廃止された。駅は地平・高架ともにタイルを1枚ずつ置く操作に統一される(詳細はprogress/free-elevated-track.md)。本ファイルが説明するテンプレート選択UI・回転操作はいずれ置き換えが必要。
