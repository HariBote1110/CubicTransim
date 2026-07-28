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

## 追記(v0.3.0-Alpha-17b: 地平の線路が浮いた高架の端に自動接続)

「浮いてる橋（高架）の端っこのタイルに線路の末端を置こうとしたら繋がるようにしたい」
という追加要望に対応した。

### 決定
- `pickElevatedConnection(info, level)`のlevel引数を`BuildLevel`(0〜3)に拡張し、
  `level===0`のときだけ「自分より高い既存レベルのうち最も近い(最小の)もの」を
  探して`connect`を返す新しい分岐を追加した(既存のlevel>=1の挙動は完全に不変)。
- `planElevatedPath`のbase/level割り当て(`assignRampZone`)を双方向に一般化した。
  `connectLevel < level`(従来: 高架建設が下位レベルへ降りる)なら`ascending`
  (baseをconnectLevelから昇順に積み上げ、接続先に近い側=level1)、
  `connectLevel > level`(今回: 地平建設が上位の高架へ登る)なら`descending`
  (baseをconnectLevel-1から降順に積み下げ、接続先に近い側=level2)。
  レンダリング用の`ramp.base`は物理的な「坂の下側の高さ」を常に正しく表す必要があり、
  この点は双方向で不変。
- **重要な落とし穴**: 双方向化しても、坂の書き込み先(`orIntoBaseLevel`が触る
  `connections`/`uppers[base]`フィールド)は「接続先に近い側のセルが、その坂の
  base(=下側の高さ)のデータを書く」という規約のままのため、descending方向では
  アンカーセル(既存の高架Mの端タイルそのもの)がbase=M-1(Mではなく1つ低い層)を
  参照してしまい、既存の`uppers[M].connections`が新しい向きのビットを獲得しない
  (=列車が既存の高架側からこの坂へ進入できない)というバグになる。ascending方向
  (従来の高架建設)では偶然アンカーが常にbaseの層と一致する(地平=0=base)ため
  この問題が表面化しなかった。
- 対策として、地平(0)専用の新関数`applyGroundPathWithElevatedConnect`
  (`applyRailPathDetailed`から、端の接続が見込める場合だけ呼ばれる)で、
  アンカーセル(接続先の既存高架レベルMの端タイルと同じ位置)は坂の通常の書き込み
  (`orIntoBaseLevel`)をスキップして`.ramp`表示用フィールドだけ付与し、ループの後で
  `uppers[M].connections`へ新しい向きのビットを直接ORする専用の後処理を追加した。
  これにより、既存の高架の端点セルが持つデータを正しく拡張しつつ、レンダリング用の
  `ramp.base`は物理的に正しい値(M-1)のまま保てる。
- 坂になるセルの車庫・水域・山岳チェックは`isElevatedConnectPlanBuildable`という
  共通の純粋関数に切り出し、`applyGroundPathWithElevatedConnect`(実際の建設)と
  `buildPreview.ts`/`useGameLogic.ts`(コスト・可否のプレビュー)の両方から使う。
  この条件を満たさない場合は、接続を諦めて**従来通りの平坦な地平線路として
  フォールバックする**(部分的な失敗で建設全体をno-opにはしない)。
- コストは`economy.ts`に`costOfGroundPathWithRamps(path, terrain, rampFlags)`を
  新設し、坂になるセルはRAIL_COST(4倍にはならない。橋桁ではなく単なる昇降のため)、
  それ以外は従来通り地形倍率つきRAIL_COSTとした。

### 代替案として却下
- アンカーセルも通常の坂セルとして扱い、坂ゾーンをbase=M-1から2M個(アンカー込み)
  で単純に割り当てる案 → 既存の`uppers[M]`が拡張されず、既存の高架から新しい坂へ
  列車が進入できないバグになるため却下(BFS経路探索の統合テストで検出)。
- `planElevatedPath`の`level`をascending専用のまま保ち、地平からの接続には
  全く別のロジックを新設する案 → 坂の役割(base/level)割り当ての大部分
  (どのセルが坂になるか、経路長の矛盾チェックなど)は完全に共通化できるため、
  既存の`planElevatedPath`を双方向対応に一般化する方が二重実装を避けられ、
  レンダリング側(`ramp.base`/`ramp.level`)の解釈も1箇所に保てる。

### ブラウザ実機検証(v0.3.0-Alpha-17b)
- 線路ツール+Lv1で(4,-2)〜(12,-2)に浮いた高架(両端とも接続先なし)を建設。
- 線路ツール+地平で(0,-2)から(4,-2)(高架の端タイル)までドラッグ建設したところ、
  `railMap`ダンプで(3,-2)(4,-2)の2セルだけが`ramp`付きになり、(0,-2)〜(2,-2)は
  平坦な地平線路のままであることを確認。
- アンカーセル(4,-2)の`uppers[1].connections`が32→34(新しい東向きのビットを獲得)
  へ正しく拡張されたことを確認(既存の高架内部の接続はそのまま保持)。
- 建設コストが合計¥4,100(高架9マス×¥400 + 地平5マス中、坂2マス×¥100+平坦3マス×¥100)
  になり、坂セルに4倍コストがかかっていないことを確認。
- 見た目も地平から高架へ滑らかに立ち上がる坂として描画され、二重描画等の違和感は
  見られなかった。

## 追記(v0.3.0-Alpha-17c: 坂(ramp)セルが破損する不具合の修正)

ユーザーから「なんか壊れる」バグ報告(高架の端付近に短いフラグメントが多数、バラバラの
角度・高さで浮いている、地平線がその区間で途切れて見える)を受けて調査・修正した。

### 根本原因
坂(ramp)セルの描画(`render/trackGeometry.ts`の`buildRampTrackParts`)は
`ramp.dir` 1方向ぶんの傾斜ジオメトリしか生成できない前提になっている
(`BOUNDARY_OFFSETS.find(o => o.bit === dir)`で単一ビットを探す)。一方
`TrackNetwork.tsx`は坂セルの`connections`/`uppers[base]`のうち、坂の軸
(`ramp.dir`とその逆)以外のビットを`flatConnections`として通常の平坦な線路部品
(`buildCellTrackParts`)で**別途**描画する設計になっている。

この前提に対し、坂セルの`connections`/`uppers[base]`に坂の軸と異なる方向の
ビットが混入すると、その方向は「高さ0(または他のbase)の平坦な部品」として
誤って描かれ、実際の坂の高さとズレた宙に浮いた破片になる。混入経路は2つ
特定できた:

1. **坂の区間そのものがカーブしている**: `planElevatedPath`は坂セルの個数
   (2×レベル差)だけを決め、経路の形状(直線かどうか)までは制約していなかった。
   ただしUIの`getConstrainedPath`(`utils.ts`)は1回のドラッグを必ず8方向の
   直線に丸めるため、**単一ドラッグでは実際には再現しない**(既存の制約で
   結果的に防がれていた)。それでも将来の呼び出し元(セーブデータの手編集、
   別UIなど)に対する防御として、坂セルでは進入方向と退出方向が正反対
   (=直線)であることを`planHasStraightRamps`で検証し、崩れていれば
   建設全体をno-opにするようにした(高架建設・地平からの自動接続の両方に適用)。
2. **本命の原因: 別々の建設(複数回のドラッグ)が、既存の坂セルを軸と異なる
   方向から通過・接続してしまう**。坂セル(特にbase=0、地平connectionsに
   ビットを書く坂)は、`.ramp`フィールドを持たない「ただの`type:'rail'`
   セル」に見えるため、後から別方向に引いた地平の線路がその位置を経由・
   終点にすると、`addConnectionToCell`が無条件に直交方向のビットを
   OR してしまい、坂セルが「1方向の坂 + 直交する平坦な接続」という
   描画不能な状態に壊れる。実際に再現テストで確認: 高架Lv1へ地平から
   接続した坂セル(3,0)へ、後から南北方向の別の線路を交差させると
   `connections`が坂の軸(東西)と交差の軸(南北)の4方向(ダイヤモンド
   クロッシング相当)になり、`.ramp`フィールドと矛盾するデータになった。
   これがユーザー報告の「別の斜めの地平線がその下をクロス」「地平線が
   途切れて見える」の正体だと考えられる。

### 修正
- `conflictsWithExistingRamp(existing, dir)`: 対象セルが既に`.ramp`を持ち、
  追加しようとしている方向`dir`が坂の軸(`ramp.dir`とその逆)に含まれなければ
  `true`を返す純粋関数を追加。
- `pathConflictsWithExistingRamp(railMap, path)`: 経路上のどこかでこの抵触が
  起きるかを判定する。`applyRailPathDetailed`の平坦な地平線路の分岐と
  `applyElevatedPath`・`isElevatedConnectPlanBuildable`(地平からの自動接続の
  可否判定、`buildPreview.ts`/`useGameLogic.ts`と共有)の両方から呼び、
  抵触する場合は建設全体をno-opにする(部分的に建設して坂を壊さない)。
  同じ軸方向への継ぎ足し(重ね引き)は従来通り問題なく成立する。

### 検証
- Vitestで、修正前は実際に上記の壊れたデータ(`connections`が4方向、
  `.ramp`と矛盾)になることを再現テストで確認したうえで修正し、
  修正後は該当する建設が完全にno-op(railMap参照が変化しない)になる
  ことを確認した(`坂セルは、別々の建設で後から直交する接続を足されても
  壊れない`)。同じ軸方向の重ね引きは引き続き成立することも確認。
- 坂の区間がカーブする経路(高架建設・地平からの自動接続の両方)が
  no-opになることを確認するテストも追加。
- ブラウザ実機検証: 対角(NE)方向の浮いた高架Lv1を建設→地平の線路を
  同じ対角方向で高架の端タイルに接続(坂2セルで正しく接続、既存の
  `uppers[1].connections`が正しく拡張されることを確認)→坂セルを南北に
  貫く交差線路をドラッグしたところ、`railMap`もmoneyも変化せず建設が
  ブロックされ、坂の見た目(斜めのレール)がそのまま保たれることを確認した。

## 追記(v0.3.0-Alpha-17d: アンカー桁セルへのramp同居バグを修正・アンカーハック廃止)

ユーザーから「高架と地上線を繋げる操作(方向に関わらず)で描画崩壊が起こる」という
再現報告を受け、17bで導入した`applyGroundPathWithElevatedConnect`のアンカー専用
後処理(`.ramp`表示フィールドだけをアンカーセルに付与するハック)そのものが
原因だったことが判明したため、設計を修正した。

### 根本原因
再現(Lv1の浮いた高架(-7,0)〜(3,0) → 地平(12,0)→(3,0)へ接続)で実際の`railMap`を
確認したところ、`3,0`(アンカー、既存の高架桁セル)が`{connections:0,
uppers:{1:{connections:34}}, ramp:{dir:32, level:2, base:0}}`という、
**桁(uppers[1]の平坦な部品)と坂(ramp)を同一セルに同居させたデータ**になっていた。
`buildRampTrackParts`(render/trackGeometry.ts)は`ramp.dir`1方向ぶんの傾斜しか
描けない前提で、`TrackNetwork.tsx`はuppers[level]の平坦な接続ビットを別途
平坦な部品として描画するため、この同居セルは「高さ1.2の平坦な桁」と「坂の上半分」
の両方として二重に描画され、破片・段差・隙間になっていた。17bの`applyGroundPathWithElevatedConnect`
がアンカーセルにも`.ramp`を付与していたことが直接の原因。

### 修正
- `planElevatedPath`の`ElevatedCellRole`に新しい種別`'anchor'`(既存の接続先レベル
  そのものを表す、坂ではない)を追加。接続先レベルM > 建設レベル(地平の線路が
  上位の既存高架へ登る向き)のときだけ、経路の端タイル(アンカー)を坂の範囲から
  明確に除外し、その1つ内側から2*|level-M|セルだけを坂として割り当てるように
  変更した。これにより、旧来の高架建設が下位へ降りる坂(M<level、アンカー自身が
  坂の最下段を兼ねても物理的に矛盾しない向き)と完全に対称なデータ形状になった。
- `applyGroundPathWithElevatedConnect`から、アンカーセルへ事後的に`.ramp`を
  付与する後処理ハックを完全に削除。role種別`'anchor'`のセルは
  `uppers[connectLevel].connections`へ新しい方向ビットをORするだけに変更した
  (桁の内部データは一切書き換えない)。
- `applyElevatedPath`(高架建設側)の書き込みループにも同じ`'anchor'`分岐を
  追加した(型の一貫性のため。pickElevatedConnectionの仕様上、高架建設は
  常にM<levelの向きしか作らないため実際には到達しないが、将来の拡張や
  型安全性のために同じ「既存データはORのみ」の扱いを用意した)。
- コスト計算(`buildPreview.ts`/`useGameLogic.ts`の`groundRampFlags`)は
  `plan.roles.map(r => r.kind === 'ramp')`のままで変更不要だった
  (アンカーは`'ramp'`ではないので自然に平坦セルと同じコストになる)。

### 検証
- Vitest: ユーザー報告と同じ形の再現テストを追加し、修正前は
  アンカーセルに`.ramp`が付与される(バグ)ことを確認したうえで、
  修正後はアンカーに`.ramp`が付かず`uppers[M].connections`のみが
  拡張されることを確認した。既存の坂割り当てテスト・pathfinding統合
  テスト(地平→坂→桁、桁→坂→地平の双方向BFS)を含む494件のVitestが
  全通過。
- ブラウザ実機検証: dev サーバでLv1の浮いた高架を建設し、地平の線路を
  その端タイルへ直線接続したところ、`railMap`が期待通りの形状
  (アンカーセルに`ramp`が無く、その手前2セルだけが`ramp`(level2→level1)、
  アンカーの`uppers[1].connections`が新しい方向ビットで正しく拡張)に
  なることを確認した。描画も地平から高架へ滑らかに立ち上がる1本の坂として
  表示され、破片・段差・二重描画は見られなかった。

## 追記(v0.3.0-Alpha-17e: ramp.dir(登り方向)が逆向きになる不具合を修正)

17dでデータ形状(アンカーにrampが無い・外側2セルがlevel2/level1)は正しくなったが、
ユーザーから「まだ描画が壊れている」と再報告があり、`ramp.dir`(登り方向ビット、
`buildRampTrackParts`が「高い側=桁のある側」として使う)が実際には**逆向き**に
書き込まれていたことが判明した。

### 根本原因
`applyGroundPathWithElevatedConnect`/`applyElevatedPath`の坂セル書き込みは、
`rampDir = role.side === 'start' ? nextDir : prevDir`という式でramp.dirを
決めていた。この式は**旧来の高架建設(ascending、桁が経路内部の別セルとして
一緒に建設されるケース)専用**の規約で、「そのside(start/end)にとって経路の
内側(桁)へ向かう向き」が登る方向になる場合にのみ正しい。

17bで追加した地平からの自動接続(descending、既存構造がまさに経路の境界セル
=アンカー自身であるケース)では、坂セルから見た「登る方向」は経路の**外側**
(アンカー側)を指すため、内側向きのprevDir/nextDirをそのまま使うと逆勾配になり、
`rampHeightAtPos`の傾斜方向が反転してジグザグの破片状描画になっていた。17dの
修正ではアンカーの有無(データ形状)は直したが、方向ビットの計算式を据え置いた
ままだったため、この逆向きバグが残っていた。

### 修正
- `rampDirResolver(plan, length)`という共有ヘルパーを追加。`plan.roles`の
  境界セル(index0またはlength-1)が`'anchor'`かどうかを見て、
  side→(prevDir|nextDir)のどちらを採用するかを切り替える:
  - アンカーが無い側(ascending、従来通り): start=nextDir、end=prevDir
  - アンカーがある側(descending、地平からの登り接続): start=prevDir、end=nextDir(逆)
- `applyGroundPathWithElevatedConnect`と`applyElevatedPath`の両方の書き込み
  ループから、この共有ヘルパーを呼ぶように統一した(直書きの式を削除)。

### 検証
- Vitest: 「経路のstart側がアンカー」「end側がアンカー」「斜め(NE)方向」の
  3パターンでramp.dirの向きをアサートするテストを追加。修正前のコードに
  戻して実行し、3件とも期待と逆向きのdirを返す(Red)ことを確認したうえで、
  修正を戻してGreenになることを確認した(既存495件+新規3件、全通過)。
- ブラウザ実機検証: dev サーバで(1)直線接続(地平→Lv1高架、西向きアンカー)
  ・(2)斜め(NE)接続(地平→Lv1高架、既存の高架ラインの内部セルへ接続する
  パターン)の両方を実際にドラッグ建設し、`railMap`ダンプで`ramp.dir`が
  アンカー側を指す正しい値になっていることと、**スクリーンショットの目視で
  桁から地面まで破片や段差の無い連続した1本のスロープに見える**ことの両方を
  確認した。17dの検証ではこの目視確認を怠っていたため今回明示的に実施した。
