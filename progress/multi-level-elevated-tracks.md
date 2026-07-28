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

## 追記(v0.3.0-Alpha-17: 高架専用ツールの廃止と建設レベルへの統合)

ユーザー決定事項により、高架建設のUI操作を全面的に再設計した。

- 決定: 「高架(7)」「高架駅(8)」ツールを廃止し、通常の「線路(2)」「駅(3)」ツールが
  選択中の建設レベル(0=地平〜3、既定0)に従う形に統合した。level:0のときは
  従来のapplyRailPath/applyStationと完全に同一の挙動になる(回帰させない制約)。
- 決定: 自由端(ドラッグの端が既存線路に接続しない側)の挙動を「自動で地平へ坂になる」
  から「そのレベルのままブツ切れで終端する(浮いた端/flat)」に変更した。これにより
  「地上の新幹線の真上だけに上野東京ラインの高架を通す」といった、地平に一切
  接続しない独立した高架層を自由に作れるようになった。
- 決定: 端の接続判定を`resolveElevatedPathEnd(railMap, pos)`(その位置に存在する
  既存レベル一覧を返す純粋関数、level引数を廃止)と`pickElevatedConnection(info, level)`
  (continue/connect/flatの3種を決める純粋関数)に分離した。continueは同レベルへの
  坂なし継ぎ足し、connectは建設レベルLより低い既存レベルMのうちLに最も近いものへ
  2*(L-M)セルの坂で接続、flatは坂を作らず終端。`planElevatedPath`はこの3種の
  ElevatedEndPlanを受け取り、接続先レベルMからbaseを積み上げる形に一般化した。
- 決定: 旧・固定長橋(`applyBridge`)は新仕様の影響を受けないよう、
  `applyElevatedPath`に`forcedEnds`引数を追加し「両端を強制的に地平(level 0)へ
  connectさせる」ことで、既存のpathfinding/reservation/simulationのテストを
  無改修のまま従来通りの「両端2セルずつ坂」の固定挙動を維持した。
- UI: `GameUI.tsx`のBUILD_TOOLSから`elevated`/`elevated-station`を削除。
  `buildLevel`を0(地平)〜3に拡張し、線路・駅ツール選択中は常にArrowUp/Downで
  切替できる(`stepElevatedLevel`も0起点にクランプ範囲を変更)。レベル表示UIは
  「地平/Lv1/Lv2/Lv3」の4択ボタンに拡張。
- UI: `GameScene.tsx`のプレビュー生成・commitPathの呼び出しを
  `buildMode==='rail'|'station'` かつ `buildLevel>0` で高架分岐する形に統合。
  `useGameLogic.ts`の`commitPath`も同様にlevel===0で従来関数、level>=1で
  `applyElevatedPath`/`applyElevatedStation`へ分岐する。
- `buildPreview.ts`: `BuildMode`から`elevated`/`elevated-station`を削除し
  `economy.ts`の`ConstructionMode`も`'rail'|'station'|'depot'|'signal'|'bridge'`に
  縮小した。UI側が「高架かどうか」を判定できるよう`BuildPreview`に`level`
  フィールドを追加した。

### 代替案として却下
- 自由端でも従来通り自動で地平へ坂を作る案 → 「地平に接続しない独立した高架層」を
  作れなくなり、今回のユーザー要望の核心(浮いた端)と矛盾するため却下。
- `resolveElevatedPathEnd`にlevel引数を残し、continuesElevated/existingLevelの
  2値を返す旧APIのまま拡張する案 → 「M<Lの既存レベルへ坂で接続」という3値目の
  分岐を無理なく表現できないため、`{levels: number[]}`を返す形に置き換えて
  `pickElevatedConnection`で判定を一本化した。

### ブラウザ実機検証(v0.3.0-Alpha-17)
- 線路ツール+Lv2で、既存線路に一切接しない区間をドラッグ建設 →
  全セルが坂なし(`ramp`未設定)で`uppers[2]`のみを持つ「浮いた高架」になることを確認
  (`railMap`ダンプで確認、描画も桁+支柱のみで坂が無い見た目)。
- 既存の地平線路の端から線路ツール+Lv1で延伸 → 接続した端だけ
  `ramp:{level,base:0}`が2セル分でき、反対側(接続先の無い端)は浮いた端のまま
  になることを確認。
- 線路ツール+Lv0(地平)で通常の線路が引けることを確認(既存の地平区間の延伸)。
- 駅ツール+Lv1で、Lv1の桁の上に高架駅(`uppers[1].stationId`)を設置できることを
  確認(近隣に町が自動で湧き駅名が命名されることも確認)。
- 既知の制約(変わらず): ブラウザ自動化ツールの合成PointerEvent(`dispatchEvent`)は
  反応しないため、建設操作の検証には`computer`ツールの`left_click_drag`/`left_click`
  を用いる必要がある。またクリック先セルの特定は、画面座標→ワールド座標の
  変換式(等角投影のx軸・z軸それぞれの画面ベクトル)を既知の建設結果から
  逆算するのが確実だった(ズレると「ここには建設できません」で無反応になり、
  原因がsim層のバグか単なる座標ズレか区別しづらいため、まずsim層の
  `evaluateBuild`を直接呼んで期待通り`ok`になるかを確認してから座標を疑うのが早い)。
