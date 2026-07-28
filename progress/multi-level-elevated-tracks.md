# 多レベル高架(離散レベル1〜3)への一般化

## 決定
- `CellData.upper`(1レベル固定)を廃止し、`uppers?: Partial<Record<1|2|3, {connections; stationId?}>>`に一般化。高さはレベルLで`L*OVERPASS_HEIGHT`。
- `CellData.ramp`に`base?: number`(坂の下側レベル、省略時0=地平)を追加。坂は`base`〜`base+1`の1段差を2セル(level1=下段/level2=上段)で結ぶ。既存の`level`(1|2)フィールドの意味は変えていない。
- `StationData.cells[].layer`を`0|1|2|3`に拡張。
- `sim/trackPath.ts`の`rampHeightAtPos(pos, base=0)`に一般化: `(base + smoothstep01(pos)) * OVERPASS_HEIGHT`。`MAX_ELEVATED_LEVEL=3`を追加。
- `sim/pathfinding.ts`: `Layer = 0|1|2|3`型を追加。`resolveEntryLayer`に`prevLayer`引数を追加し、(a)直前の走行層と同じ候補を最優先、(b)無ければ坂(`ramp.base`)による1段差の遷移を許可、(c)それも無ければ地平優先、で層を一意に決める。
- `sim/construction.ts`:
  - `planElevatedPath(length, startCont, endCont, targetLevel)`: 自由端の坂は`2*targetLevel`セル(1段差につき2セル、baseを0から積み上げ)。
  - `resolveElevatedPathEnd(railMap, pos, level)`: `continuesElevated`は**そのレベルの桁が既にあるか**だけを見る(他レベルは無視、独立して併存できるため)。`existingLevel`は別レベルの桁があれば返す(情報用途。呼び出し側で無条件にブロックはしない — 別レベルの桁の上に新しいレベルの坂を通すのは正当な構成のため)。
  - `applyElevatedPath(..., level)`: 桁は`uppers[level]`にOR。`level===1`のときのみ地平connectionsの平面交差ビットを剥がす(従来互換)。`level>1`では下位レベルの線路には触れない。同一レベルへの二重架けのみ禁止、異なるレベルは併存可。
  - `applyElevatedStation(..., level)`・`removePath`・`revertDanglingRamps`をレベル対応に一般化(`removePath`は対象セルの全レベルの`uppers`をまとめて撤去する仕様のまま)。
- `sim/reservation.ts`: `reservationKey`のキーを`x,z:u1`〜`u3`に拡張(高架レベルごとに独立した閉塞資源)。
- `sim/simulation.ts`: `Grid.layer?: 0|1|2|3`。`cellCentreHeight`/`interpCellHeight`は正規化posではなく高さ自体を線形補間する方式に変更(区間ごとにbaseが異なり得るため、より安全な一般化)。
- `sim/persistence.ts`: `SaveDataV13`を追加(構造はV12と同一、CellDataの形が`uppers`に変わった区切り)。V12以前の読み込みで`upper`→`uppers[1]`、`ramp.base??0`を補うマイグレーションを追加。

## 代替案として却下
- `resolveElevatedPathEnd`が別レベルの桁を検出したら常に建設不可にする案 → 「レベル1の桁の上にレベル2の坂を新たに通す」という正当なケースまでブロックしてしまうため却下。既存の同レベル二重架け禁止チェックだけで十分。
- `interpCellHeight`をpos補間のまま一般化する案 → base(坂の下位レベル)が区間の前後で異なりうる一般ケースでは破綻するため、高さ自体を補間する方式に変更。

## 制約・注意
- v12以前のセーブに存在した「upperはあるがconnections=0」というエッジケースの後方互換コードは、`uppers`移行時に単純化して削除した(実質発生しない状態のため)。

## 追記(描画・UI対応)
- `render/trackGeometry.ts`: `buildRampTrackParts`に`base`引数を追加し`rampHeightAtPos(pos, base)`を呼ぶように一般化。`buildOverpassSupportParts`/`buildBridgeAbutmentPart`はもともと`originY`を外から渡す設計だったため変更不要(呼び出し側がレベルごとの高さを渡すだけで多レベル対応できた)。`buildRampPierPart`を新設し、`base>=1`(地平に接しない、空中に架かる坂)を土盛りの橋台ではなく1本の支柱で支える見た目にした。
- `components/TrackNetwork.tsx`: `uppers[1]`固定だった全ループを`ELEVATED_LEVELS=[1,2,3]`走査に一般化し、レベルLの桁・レール・支柱を`originY = L*OVERPASS_HEIGHT`で生成。坂は`ramp.base`が0のときだけ従来通りの土盛りくさび(`buildRampAbutmentPart`)、`base>=1`のときは`buildRampPierPart`で支柱を1本立てる。橋台(擁壁)候補の判定もレベルごとに独立させた。
- `render/stationLayers.ts`: `elevatedStationCells`が全レベルを走査するよう変更し、`StationLayerCell.level`(1〜3、省略時は地平扱い)を追加。同一セルに複数レベルの高架駅ホームが併存するケースも`key`にレベルを含めて別セルとして扱う(Vitestで検証)。
- `components/GameScene.tsx`: 高架駅ホーム・駅舎(`StationHouse`)・ラベルの描画高さを、固定の`OVERPASS_HEIGHT`から`cell.level * OVERPASS_HEIGHT`(駅舎は複数レベルにまたがる場合、最も低いレベルに置く/ラベルは最も高いレベルに合わせる)に一般化。地平クリックからの高架駅セル逆算(`elevatedCellCandidateFromGroundClick`)もレベル1〜3を順に確認するようにした。
- UI: `GameUI.tsx`に`buildLevel`(1〜3、既定1)を追加。高架/高架駅ツール選択中のみ`ArrowUp`/`ArrowDown`でレベルを切り替える(クランプ処理は`sim/trackPath.ts`の`stepElevatedLevel`という純関数に切り出しVitestでテスト)。ツールバー上にレベル切替ボタン(押しても良い、キーボードでも良い)を表示。`buildLevel`は共通の親である`App.tsx`が保持し、`GameScene`(プレビュー生成・`onCommitPath`呼び出し)と`GameUI`(コスト・可否プレビューの`evaluateBuild`呼び出し)の両方へ渡す。
- ブラウザ実機検証: レベル2・レベル3の高架線をドラッグ建設し、`railMap`に想定通り`ramp.base`が0→1(→2)と積み上がること、`uppers[2]`/`uppers[3]`の桁ができること、レベル2の桁の上に高架駅(`layer:2`)を設置できることを確認した。レベル3の坂は`base>=1`の区間が支柱で支えられ、地平に接するレベル1の坂だけが土盛り(くさび)になっている見た目を確認した。
- 既知の制約: ブラウザ自動化ツールの合成`PointerEvent`(`dispatchEvent`によるJS注入)はreact-three-fiberのラウンドトリップに反応せず、実際のOS入力に近い`computer`ツールの`left_click_drag`でないと建設操作が成立しなかった(今後この環境で建設操作を検証する際の注意点として記録)。列車を実際に地平↔高架間で走らせる検証(路線・車両購入まで)は今回は未実施(データ・描画の確認まで)。
