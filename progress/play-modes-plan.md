# プレイモード計画（ライト/ノーマル/アドバンスド/リアリスティック）

状態: **PM4 実装済み**（PM3の交直流電化(boundaries)に加え、'feeding'段階の
変電所・き電区間・給電判定・容量超過ペナルティまで完了。リアリスティックモードの
電化「全部盛り」計画は本PM4で最後の階層まで到達した）。
2026-08-11 の設計会話を基に作成、同日PM1着手。0.5.0-Alpha-7aでPM3完了、
0.5.0-Alpha-8aでPM4完了。

## 実装メモ（PM4、0.5.0-Alpha-8a）

- **設計判断: 変電所は車庫と同じくrailMapのセル1つとして持つ**（`CellType`に
  `'substation'`を追加しただけ）。専用のMap/配列を新設しなかったため、
  セーブスキーマの版上げ（当初の想定はv18）は不要だった——`railMap`は既存の
  「Mapを丸ごとentries配列でシリアライズ」の仕組みにそのまま乗るため。
  タスク定義時点の「おそらくv18」という見積りは、この設計判断（車庫パターンの
  完全踏襲）によって実際には不要になった、という点をここに明記しておく。
- `src/sim/feeding.ts`（新設）: `buildFeedingIndex(railMap, substations)`が
  純粋関数として`FeedingIndex`（`isPowered`/`sectionLoadKey`/`sectionCapacity`）を
  返す。き電区間（同一系統dc/acの電化railセルの連結成分、地平connectionsのみを
  辿るBFS）ごとに、隣接する変電所からの多始点BFSで給電範囲
  （`DC_FEED_RANGE_CELLS=48`/`AC_FEED_RANGE_CELLS=160`、変電所隣接セルを距離0とした
  ホップ数）を判定する。セクション容量は接続する変電所数×`SUBSTATION_CAPACITY_TRAINS`
  （=3）。**高架・地下（level!==0）は本PM4のスコープ外**とし、`isPowered`は常にtrue・
  `sectionLoadKey`は常にnullを返す単純化にした（follow-up）。
- `src/sim/construction.ts`: `applySubstation`を車庫の`applyDepot`と対称な形で実装。
  平地・空セル・非町タイルであることに加え、8近傍（またはセル自身）に電化railが
  あることを要求する。`SUBSTATION_COST=¥8,000`（`economy.ts`）。
- `src/sim/pathfinding.ts`: `RouteQuery`に`feeding?: FeedingIndex`を追加。BFSの
  隣接セル探索で`rules.electrification==='feeding' && trainPower!=='diesel' && feeding`
  のときだけ`feeding.isPowered(tx,tz,nextLayer)`を追加チェックする。`gameRules.ts`
  自体は無改造（純粋関数のまま、feeding索引は呼び出し側が渡す設計、design decision 3
  どおり）。
- `src/sim/physics.ts`: `computeAcceleration`に`tractionFactor=1`引数を追加。
  牽引力（forceN）にのみ乗算し、ブレーキ・惰行（coasting）には影響しない
  （design decision 4「traction only」）。
- `src/sim/simulation.ts`: `SimWorld`へ`feeding?: FeedingIndex`を追加
  （`rules`と同じくReact側が鏡写しする、セーブ対象外の派生キャッシュ）。
  `stepWorld`が電車の在線数をtick開始時点で1パス先に数えて`feedingSectionCounts`
  （`Map<sectionKey, count>`）を作り、`stepTrain`へ渡す。各列車の加速分岐で
  自セクションの容量超過を判定し、超過時は`OVERLOAD_ACCEL_FACTOR=0.5`を
  `tractionFactor`として渡す。気動車（`power==='diesel'`または未設定）は対象外。
- `src/hooks/useGameLogic.ts`: `feedingIndex`を`useMemo(() => buildFeedingIndex(...), [railMap])`
  で持つ（`townTileIndex`と同じ規律、railMap変化時のみ再計算）。substations一覧は
  railMapを走査して`type==='substation'`のセルから毎回導出する。
  `worldRef.current.feeding`へ`useEffect`で鏡写しする。
- UI: `GameUI.tsx`に「変電所」ツールボタン（キー'0'、`rules.electrification==='feeding'`
  のときのみ表示、改軌ツールと同じ表示条件の規約）を追加。`GameScene.tsx`は
  変電所を駅・車庫・信号と同じ単一セル配置モードとして扱う。
- 描画: `render/substationGeometry.ts`（新設）が変圧器の箱+碍子3本のシンプルな
  メッシュを生成する（車庫と同じ「9メッシュ程度の固定形状」の方針）。
  `WebGpuTrackExtras.tsx`・`meshChunkRegistry.ts`（`substation: 0x9000_0000`名前空間）・
  `palette.ts`（`substationBody`/`substationTransformer`/`substationInsulator`）へ配線。
  `railGeometry.ts`/`townTiles.ts`の`type==='depot'`判定に`'substation'`も加え、
  線路描画の対象外・町タイルの占有判定を車庫と揃えた。
- ブラウザ実機（リアリスティックモード、小マップ）で、変電所ツールボタンの表示・
  電化DC線路の建設・変電所の設置（`window.__debugWorld.railMap`に
  `{type:'substation'}`セルが載ることを確認）・`window.__debugWorld.feeding`が
  設置した区間の全セルを`isPowered:true`として報告すること・変電所メッシュの
  描画をスクリーンショットで確認した。ノーマルモードでは`改軌`ツールは出るが
  `変電所`ツールは出ないことも確認した。`npm run test`（1056件、うち1件は
  無関係な既存の性能タイミングテストの単発flakeで再実行後green）・
  `npm run build`ともgreen。
- **残るfollow-up**: 高架・地下のき電（本PM4は地平のみ、design decision通り
  スコープ外として明示）、変電所の選択/検査UI（「コストがかかるならスキップ可」の
  指示どおり未実装）。これでPM1〜PM4（電化の「全部盛り」計画）は完了し、
  リアリスティックモード固有の目玉機能が出揃った。

## PM4フォローアップ: き電区間の可視化オーバーレイ(0.5.0-Alpha-9b)

- `src/render/feedingOverlay.ts`（新設）: `buildFeedingOverlayCells(railMap, feeding,
  feedingSectionCounts?)`が純粋関数として、地平の電化rail/stationセルと変電所セルを
  `{x, z, colourKind}`（`'powered'|'unpowered'|'overload'|'substation'`）へ塗り分ける。
  非電化railセルは結果に含めない。Vitestで先にRed→Green（`feedingOverlay.test.ts`）。
- `src/components/WebGpuFeedingOverlay.tsx`（新設）: `WebGpuBuildPreview.tsx`と同じ
  「署名が変わったときだけメッシュチャンクを焼き直す」パターンで、`buildMode==='substation'`
  のときだけ半透明の板を`MESH_LAYER_CLASS.translucent`チャンクとして供給する
  （`rules.electrification==='feeding'`のときしか変電所ツール自体が出ないので、
  専用トグルは持たせずbuildModeの条件だけで足りる、という指示どおりの設計）。
  `GameScene.tsx`に`WebGpuBuildPreview`と並べてマウントした。
- **overload(容量超過)tintは実装した**（当初「アクセスが侵襲的ならフォローアップに
  回してよい」という指示だったが、実際には`SimWorld.feedingSectionCounts`を
  `stepWorld`が既に1tick分先に数えていた値をそのまま鏡写しするだけで済み、侵襲的では
  なかったため実装した）。`simulation.ts`の`stepWorld`内、容量超過ペナルティ判定用に
  ローカルで数えていた`feedingSectionCounts`を`world.feedingSectionCounts = ...`で
  1行だけ鏡写しする（セーブ対象外、デバッグ・オーバーレイ用の副産物）。
- **実機検証で踏んだ罠(重要)**: 板を「地表すれすれ」の絶対y座標（例: y=0.035）に
  置くと、`render/trackGeometry.ts`のバラスト（`BALLAST_HEIGHT=0.06`）・レール頭頂
  （`RAIL_TOP=0.13`）という不透明ジオメトリに埋もれて完全に見えなくなる。板のyは
  `RAIL_TOP`より上（実装は`0.13 + height/2 + 0.01`）へ持ち上げる必要がある。
  さらに、地形が平坦でない地平セル（丘・自動トンネル区間）では、絶対y=0基準の板は
  地形の中に埋もれる。`render/townGeometry.ts`等と同じ変換式
  `field.cellHeightAt(x,z) * OVERPASS_HEIGHT`を高さオフセットとして加算する必要がある
  （`WebGpuFeedingOverlay`に`field: TerrainField`propを追加）。どちらも実機スクリーン
  ショットで初回は「オーバーレイのデータは正しいのに何も描画されない」という形で
  露見した——純粋関数のテストだけでは検出できない、wgpu側の描画専用の罠。
- ブラウザ実機（リアリスティックモード、小マップ、平坦地形）で確認: DC電化線路
  （61セル）+変電所1棟を建設し、変電所ツール選択中は近傍(48セル以内)が緑
  （`powered`）、48セルを超えた先が赤（`unpowered`）に塗り分くこと、変電所セル
  自体が青い強調板になること、`選択`ツールへ切り替えるとオーバーレイが消えること
  をスクリーンショットで確認した。`npm run test`（1084件）・`npm run build`とも
  green。

## 実装メモ（PM3、0.5.0-Alpha-7a）

- `src/types.ts`: `CellData.electrified`を`boolean`から`'dc'|'ac'|boolean`へ拡張(legacyの
  `true`=直流)。`TrainPower`に`'electric-ac'`(交流専用)・`'electric-acdc'`(交直流両用)を追加。
  既存の`'electric'`は「直流専用車」の意味に固定した(名称は変えていない)。
- `src/sim/gameRules.ts`: `electrificationOf(cell): 'dc'|'ac'|null`を新設し、legacyの
  `true`を`'dc'`へ正規化する唯一の場所にした(persistence.tsの読み込み時正規化に加え、
  こちらも防御的に同じ変換をする二重化)。`cellAllowsTrain`を拡張し、
  diesel=常に許可/electric=dc限定/electric-ac=ac限定/electric-acdc=dc・ac両方許可、
  という表を実装。`isDeadSectionBoundary(a, b)`を新設し、隣接2セルが「両方電化かつ
  方式が異なる」ときだけtrueを返す(片方が非電化の境界はデッドセクションではない)。
- `src/sim/pathfinding.ts`: **コード変更なし**。`cellAllowsTrain`が交直流を判定するように
  なったことで、BFSは自動的に「dc専用車はac区間を含む経路を選ばない」ようになる
  (design decision 4で「自然に落ちる」と想定した通り、テストで確認)。
- `src/sim/physics.ts`: `computeAcceleration`のmodeに`'coasting'`を追加。牽引力を0にし、
  既存の転がり抵抗・空気抵抗の項だけを差し引く(新しい減速モデルを追加したのではなく、
  既存の抵抗項をそのまま流用する)。
- `src/sim/simulation.ts`: `stepTrain`の加速分岐で、現在セル(`rt.grid`)と次セル
  (`nextTile`)が`isDeadSectionBoundary`ならmode='coasting'を使う。「先頭が境界の前後
  1セル以内」を「現在セルと次セルの電化方式差」で近似している(1セル単位の粒度なので
  これで要件を満たす)。最低進入速度・失速はPM3のスコープ外(follow-upとして残す)。
- `src/sim/economy.ts`: `trainCostFor(power)`を新設。`AC_TRAIN_PRICE_MULTIPLIER=1.2`
  (交流+20%)・`ACDC_TRAIN_PRICE_MULTIPLIER=1.5`(交直流+50%)、diesel/electric(直流)は
  従来のTRAIN_COSTのまま(値は「あったら楽しい」判断)。
- `src/hooks/useGameLogic.ts`: `buyTrain`が`trainCostFor(power)`で動力別に課金するよう変更
  (電化概念が無い場合はTRAIN_COST固定)。
- `src/sim/persistence.ts`: `deserialiseWorld`でrailMapのエントリを走査し、
  `electrified === true`のセルを`'dc'`へ書き換える。バージョン上げは不要
  (CellDataの型が広がっただけで、既存のMap丸ごとシリアライズの仕組みはそのまま)。
- `src/components/GameUI.tsx`: `rules.electrification`が`'modes'`のときは従来の
  電化/非電化トグルのまま、`'boundaries'`以上では非電化/直流/交流の三択ボタンに切り替わる。
  車庫の購入動力選択に、`'boundaries'`以上でのみ交流電車/交直流電車ボタンを追加
  (ボタンのtitleに`trainCostFor`の価格を表示)。
- `src/render/palette.ts` / `railGeometry.ts`: `catenaryMastAc`/`catenaryWireAc`
  (直流よりわずかに青みがかった色)を追加。`buildRailNetworkGeometry`が
  `electrificationOf(cell)`で`'ac'`セルの架線を`catenaryAc`バケット、それ以外を
  従来の`catenary`バケットへ振り分ける。`WebGpuTrackNetwork.tsx`のsurfaceチャンクへ
  `catenaryAc.masts`/`.wires`を追加しただけ(デッドセクション自体の専用視覚表現は
  スコープ外、follow-upとして残す)。
- 信号(signalling)は本PM3では**コード変更なし**。progress/signalling-plan.mdへ
  「S0(おまかせ・CBTC風の移動閉塞)は現行の予約(PBS)＋制動距離システムがそのまま
  実装として機能しており、rules.signalling='s0'が既定として正式に運用中」という
  ステータス追記のみ行った(design decision 7どおり)。
- ブラウザ実機(アドバンスドモード)で、`window.__debugWorld.railMap`に'dc'/'ac'セルが
  正しく載ること、GameUI.tsxの三択電化セレクタ・交流/交直流車購入ボタンの表示切替、
  架線のac色分けをスクリーンショットで確認した(詳細は本ファイル末尾の検証ログ参照)。
  `npm run test`(1037件)・`npm run build`ともgreen。
- **残るfollow-up**: 最低進入速度/デッドセクション内での失速(design decision 4で
  明示的にスコープ外)、デッドセクション自体の専用視覚表現(design decision 5で
  明示的にスコープ外)、電化の「給電インフラ」段階(`electrification: 'feeding'`、
  リアリスティック固有、PM4以降)。

## 実装メモ（PM2、2026-08-11）

- `src/types.ts`: `RailGauge`型(`762|1067|1372|1435`)・`DEFAULT_GAUGE`(1067)・
  `TrainPower`型(`'diesel'|'electric'`)を新設。`CellData`に`gauge?`/`electrified?`、
  `TrainData`に`gauge?`/`power?`を追加(すべてoptional・省略時は旧来どおり)。
  高架(uppers)・地下は本セルと軌間を共有する単純化とし、立体交差した別レベルの線路が
  異なる軌間を持つケースはPM2のスコープ外とした。
- `src/sim/gameRules.ts`: `GameRules`へ`extendedGauges: boolean`を追加(基本ラインナップ
  =false、リアリスティックのみtrue)。`playModeOf`もこのフィールドの一致を見るよう拡張。
  `effectiveGauge`/`gaugesCompatible`/`cellAllowsTrain`の3つの純関数を実装。
  いずれも`rules.gauge===false`なら概念が無いものとして無条件でtrue(許可)を返す
  短絡を持ち、「ライトモードは挙動変更ゼロ」を型レベルではなくロジックレベルで保証する。
- `src/sim/construction.ts`: `addConnectionToCell`に`RailBuildOptions`
  (`{gauge?, electrified?}`)を追加。既存の線路セルと軌間が異なる場合はその方向の
  接続ビットを立てない(セル自体は敷設される。「軌間の違う線路は繋がらない」という
  仕様をコネクションレベルで表現)。`applyRailPathDetailed`/`applyRailPath`に
  `railOptions`引数を追加(省略時は空オブジェクト=既存挙動と完全一致)。
- `src/sim/pathfinding.ts`: `RouteQuery`に`rules`/`trainGauge`/`trainPower`を追加。
  BFSの隣接セル探索で`cellAllowsTrain`を呼び、軌間ミスマッチと電化必須セルへの
  気動車以外の進入を拒否する。省略時は`DEFAULT_GAME_RULES`(ライト相当)に短絡。
- `src/sim/economy.ts`: `ELECTRIFICATION_COST_MULTIPLIER = 0.5`(架線設備費、
  線路本体の+50%/セル、値は「あったら楽しい」判断)と`costOfElectrification`を追加。
- `src/sim/buildPreview.ts`: `evaluateBuild`に`railOptions`引数を追加。地平
  (level 0)のrail建設のみ、electrified指定時に架線設備費を上乗せし、
  gauge/electrifiedをそのまま`applyRailPathDetailed`へ橋渡しする(UIに条件を
  書き写さない既存規約どおり)。
- `src/hooks/useGameLogic.ts`: `buyTrain`に`power`引数(既定'diesel')を追加。
  `rules.gauge`が有効なら購入位置(車庫セル)の軌間を新造列車へ自動継承する。
- 永続化: `CellData`/`TrainData`は既存の「Mapを丸ごとentries配列でシリアライズ」に
  乗るため、persistence.ts側の変更は`rules.extendedGauges`のフィールド単位デフォルト
  補完のみで済んだ。**v18への版上げは不要**。

### 追記(PM2続き、2026-08-11): 本番経路探索・高架/地下・Stage B/C

- **simulation.ts本番経路探索への配線**: `SimWorld`に`rules?: GameRules`を追加し、
  `useGameLogic.ts`が既存のrailMap/stations等と同じ`useEffect`同期パターンで
  `gameRules` stateを鏡写しするようにした。`stepTrain`内2箇所の
  `calculateRouteWithStop`呼び出しに`rules`(未設定時は`DEFAULT_GAME_RULES`)・
  `train.gauge`(既定1067)・`train.power`(既定diesel)を渡す。`rules`未設定の
  ワールド(旧セーブ・デバッグシナリオ)は短絡するため挙動は変わらない。
- **高架/地下へのgauge配線**: `applyElevatedPath`/`applyUndergroundPath`に
  `RailBuildOptions`引数を追加。高架・地下は「セル単位で1つの軌間を共有する」
  単純化のもとCellData本体(uppersの外側)へgauge/electrifiedを付ける
  (uppers側のレベル別データは変更しない)。異なる軌間の既存セルへの接続拒否
  (地平と同じロジック)は高架/地下には実装していない(スコープ外のまま)。
  `buildPreview.ts`のelectrified追加コストとapply呼び出しを地平/高架/地下すべてに拡張。
- **Stage B(改軌ツール)**: `construction.ts`に`applyRegaugePath`を実装。既存の
  自線路(`type==='rail'`、駅・車庫・立体交差は対象外)の軌間を一括変換し、既に
  目的軌間のセルは無料でスキップ、経路中に非railセル・列車在線中のセルが1つでも
  あれば全体をno-opにする。電化フラグは変更しない。`economy.ts`に
  `REGAUGE_COST_PER_CELL = RAIL_COST × 0.6`(=60円/セル。撤去+再敷設の100円/セルより
  安い「あったら楽しい」判断)と`costOfRegauge`を追加。`buildPreview.ts`の
  `BuildMode`へ`'regauge'`を追加し、apply結果から実際に変わったセル数を数えて
  コスト・可否を返す(他モードと同じ規約)。
- **Stage C(UI)**: `GameUI.tsx`に線路ツール用の軌間セレクタ(基本: 狭軌/標準軌、
  `rules.extendedGauges`なら特殊狭軌/馬車軌間を追加)と電化/非電化トグルを、
  建設レベル行と同じ`panel()`+`button()`スタイルで追加。改軌ツールボタン
  (`rules.gauge`のときのみ表示、キーボードショートカット'9')と目的軌間セレクタも
  追加。車庫ツールには購入動力(電車/気動車)選択を追加(`rules.electrification!=='none'`
  のときのみ表示。軌間は車庫セルから自動継承、既存のbuyTrainの挙動どおり)。
  `commitPath`(useGameLogic.ts)に`railOptions`/`regaugeTargetGauge`引数を追加し、
  `App.tsx`が対応するReact stateを持って`onCommitPath`/`onBuyTrain`のクロージャで
  橋渡しする(`GameScene.tsx`は`BuildMode`型の変更のみで済み、呼び出しシグネチャは
  無改造)。ブラウザ実機(ノーマルモード)で軌間/電化UI・改軌ボタンの表示条件・
  トグル操作を確認済み。
- **残る follow-up**: 軌間・架線の見た目の違い(描画差)のみ。元のタスク定義どおり
  スコープ外として据え置く。→ 0.5.0-Alpha-6bで着手・完了(下記)。

### 追記(PM2描画差、0.5.0-Alpha-6b)

- **軌間の見た目**: `render/trackGeometry.ts`の`layTrackAlong`に`gauge?: RailGauge`引数を
  追加し、`gaugeScaleFactor(gauge)`(=`gauge/DEFAULT_GAUGE`、gauge省略時は1)でレール間隔
  (`RAIL_SPACING`)と枕木幅(`SLEEPER_WIDTH`)をスケールする。中心線(sim/trackPath.ts)は
  一切変更していないので、列車の走行位置・当たり判定はずれない。`buildCellTrackParts`/
  `buildGroundInclineTrackParts`/`buildRampTrackParts`にgauge引数を追加して橋渡しし、
  `railGeometry.ts`の各呼び出し箇所へ`data.gauge`をそのまま渡す。無回帰要件(gauge省略時は
  従来とbyte-identical)はスケール1.0のとき`定数 * 1 === 定数`(浮動小数点演算として等価)に
  なる設計で満たし、`trackGeometry.test.ts`/`railGeometry.test.ts`にgauge省略時の
  position配列一致テストを追加して確認した。ブラウザ実機(ノーマルモード、標準軌1435 vs
  基本ラインナップの狭軌1067)で幅の違いを目視確認済み(762は`rules.extendedGauges`が
  必要なためリアリスティックのみ)。
- **架線(catenary)**: `trackGeometry.ts`に`buildCatenaryParts(connections, x, z, originY)`
  を新設。ポール(マスト+腕木、シンプルな箱ジオメトリ)は`shouldPlacePier`と同じ「軸方向の
  セル整数インデックスの剰余」方式で3セルおきに間引き(`CATENARY_POLE_SPACING=3`)、電線
  (細い箱)は間引かず中心線に沿って全セルへ敷く。`railGeometry.ts`は地平の平坦区間
  (`flatConnections`)と高架(uppers level>0)の`data.electrified`セルだけを対象にした
  (坂・傾斜は対象外、スコープを絞ってジオメトリの増加を抑える判断)。**地下は呼ばない**
  (第三軌条の見た目は未実装、地下ビューでの表現は今後の課題として残す)。色は
  `palette.ts`に`catenaryMast`/`catenaryWire`を追加。`WebGpuTrackNetwork.tsx`の
  surfaceチャンクへ`geometry.catenary.masts`/`.wires`を追加しただけで、
  `buildChunk`のuseCallback依存配列(`[geometry]`)はそのまま(geometryオブジェクト自体が
  railMap変化のたびに再計算されるため、既存の変更検知の仕組みに乗る)。
- ブラウザ実機(ノーマルモード)で、標準軌+電化のセルにポール・電線が、狭軌+非電化の
  隣接セルには何も出ないことを確認。ライトモードの新規ゲームでは軌間・電化のUIごと
  出現せず、線路の見た目も従来どおり(架線・幅変化なし)であることも確認した。
  `npm run test`(1023件)・`npm run build`ともgreen。

## 実装メモ（PM1、2026-08-11）

- `src/sim/gameRules.ts` を新設。`GameRules`型（`gauge`/`electrification`/`signalling`の3軸）、
  `PLAY_MODE_PRESETS`（ライト/ノーマル/アドバンスド/リアリスティックの4プリセット。
  signallingはいずれも既定`'s0'`で揃え、独立軸として扱う）、`DEFAULT_GAME_RULES`（ライト相当）、
  日本語表示ラベル`PLAY_MODE_LABELS`、逆引き`playModeOf`（gauge/electrificationの組がどの
  プリセットとも一致しなければ`'custom'`。signallingは無視）を実装。
- セーブスキーマを **v17** へ拡張（`src/sim/persistence.ts`）。`rules?: GameRules`を追加し、
  v16以前（rules欠落）は`DEFAULT_GAME_RULES`として読み込む。モード名ではなくフラグ集合を
  保存する計画どおり。降格禁止ルールはPM1では未着手（rulesを誰も参照しないため実害なし。
  PM2以降でgauge/electrificationを実際の建設判定に使う段階で検討する）。
- `src/hooks/useGameLogic.ts` に `gameRules` state を追加し、`townDensity`/`terrainProfile`と
  同じ経路（save時はserialiseWorldへ渡す、load時はsetGameRules、newGame時は引数で受け取る）
  で配線。`worldRef.current`（SimWorld）には乗せず、React state止まり（既存2値と同じ扱い）。
- `src/App.tsx` の新規ゲームダイアログに「プレイモード」ボタン行を追加（町の密度/地形と同じ
  `themeButton`パターン、既定選択はライト）。選択したプレイモードのプリセットを
  `newGame(halfExtent, townDensity, terrainProfile, PLAY_MODE_PRESETS[selectedPlayMode])`
  として渡す。選択中モードの一行説明を表示。
- PM1のスコープどおり、rulesはセーブ・ロード・UI表示以外のどこからも読まれない
  （construction.ts / pathfinding.ts などの可否判定には未接続）。`npm run test` /
  `npm run build` とも green。PM2で軌間・電化方式(`electrification: 'modes'`)の
  静的可否判定へ接続する。

## 目的

鉄道の複雑な概念（軌間・電化・交直流など）を段階的に開放する4つのプレイモードを導入し、
新規プレイヤーの学習曲線を緩やかにしつつ、上級者には「全部盛り」の深さを提供する。

## モード定義

| モード | 追加される概念 |
| :--- | :--- |
| ライト | 何も追加しない（現行仕様そのまま。軌間・電圧・交直の概念なし） |
| ノーマル | 軌間の選択、電化方式の選択（直流のみの単純な扱い） |
| アドバンスド | ノーマル + 交直流（交流電化、交直デッドセクション、交直流車） |
| リアリスティック | 鉄道のややこしい部分全部盛り。**特に電化まわりを全部盛りにする**（下記） |

- 信号方式（閉塞方式など）は**モードとは独立した別軸の選択**とする。
  「電化は簡単でいいが信号は本格的に」という層を取りこぼさないため。
- 旧称「ハードモード」は「リアリスティックモード」へ改名済み（名称のみ、2026-08-11決定）。

## 実装アーキテクチャ: モードは「ルールフラグのプリセット」

モード名を直接分岐条件にしない。内部的にはルールフラグ集合を持ち、4モードはその既定値セットとする。

```ts
interface GameRules {
  gauge: boolean;                                          // 軌間の概念の有無
  electrification: 'none' | 'modes' | 'boundaries' | 'feeding'; // 電化の段階
  signalling: SignallingRules;                             // 別軸（モード非依存）
  // 将来の拡張はここへ追加
}
```

- ライト = `{gauge: false, electrification: 'none'}`
- ノーマル = `{gauge: true, electrification: 'modes'}`
- アドバンスド = `{gauge: true, electrification: 'boundaries'}`
- リアリスティック = `{gauge: true, electrification: 'feeding'}`

利点:
1. 信号別選択が自然に収まる
2. 将来「カスタムモード」がフラグの直接編集だけで手に入る
3. sim層のテストをモード名でなくフラグ単位で書ける

### セーブデータ

- **モード名ではなくフラグ集合を保存する**（現行 v16 スキーマへの追記）。
  後からモード定義（既定値セット）を変えても既存セーブが壊れない。
- 既存セーブ（フラグ無し）はライト相当のフラグで読み込む。
- モードの昇格（ライト→ノーマル等）のみ許可し、降格は不可とする。
  昇格規則の例: ライトのセーブをノーマルで開くと全線が標準軌・非電化扱いになる。
  降格は情報が落ちるため定義しない。

## 電化の「全部盛り」の内訳（リアリスティックの本丸）

電化のややこしさは4階層に整理できる。要素同士が
「変電所→き電区分→デッドセクション→車両の対応電源」という一本の因果で繋がるため、
ゲームメカニクスとして破綻しにくい。

### 1. 方式の選択（`electrification: 'modes'`、ノーマルから）
- 非電化 / 直流(600V・750V・1500V) / 交流(20kV 50Hz・60Hz、25kV)
- 架線 vs 第三軌条。第三軌条は地下・都市向けで、踏切と相性が悪い・雪に弱い等の制約が個性になる

### 2. 境界の処理（`electrification: 'boundaries'`、アドバンスドから）
- 交直デッドセクション: 惰行で通過、通過速度の下限、通過できるのは交直流車のみ
- 異周波数境界（50/60Hz）
- 直流同士でも電圧が違えば直通不可、または複電圧車が必要

### 3. 給電インフラ（`electrification: 'feeding'`、リアリスティック固有の目玉）
- 変電所の設置とき電区間: 変電所から一定距離しか給電できない
- 同一き電区間の在線数が容量を超えると電圧降下で加速力が落ちる
  （physics.ts の加速モデルに係数として載せる）
- 直流は変電所間隔が短い（数km）・交流は長い（数十km）→
  「初期費用は交流が安いが車両が高い」という実物どおりのトレードオフが自然に出る

### 4. 車両側
- 対応電源: 直流車 / 交流車 / 交直流車 / 気動車 / バッテリー・デュアルモード
- 交直流車・複電圧車は高価、という価格差で路線計画に効かせる

### やりすぎ警戒ライン
- 電圧降下の連続シミュレーション（回路計算）は**やらない**。
  「同一き電区間の在線数が容量を超えたら加速率に一律ペナルティ」程度の離散近似で、
  プレイヤーに見える因果は十分成立し、sim層のテストも書きやすい。

## 実装フェーズ（案）

| フェーズ | 内容 | リスク | 状態 |
| :--- | :--- | :--- | :--- |
| PM1 | `GameRules` 型・フラグ集合の骨組み、セーブ拡張、モード選択UI。**現行仕様＝ライトと定義するだけ**で挙動変更なし | 小 | 完了 |
| PM2 | 軌間 + 電化方式（modes）。建設時の方式選択、pathfinding/建設可否の静的述語（通れる/通れない） | 中 | 完了 |
| PM3 | 境界（boundaries）。デッドセクション、車両の対応電源、惰行通過 | 中 | 完了 |
| PM4 | き電（feeding）。変電所の建設物、き電区間の索引、容量超過ペナルティ | 大 | 完了 |
| PM5 | 信号方式の別軸選択（詳細は別メモで設計） | — | 未着手 |

- PM1 から着手する。挙動変更ゼロでモードの器だけ入るため、リスクが最小。
- 1・2階層（modes/boundaries）は静的な可否判定（construction.ts / pathfinding.ts の述語追加）で済む。
  3階層（feeding）だけが運行密度と絡む動的な問題で、ダイヤを組むゲーム性と直結する。
- リアリスティック自体も内部的には段階リリースとする（全部を一度にやらない）。

## リアリスティックの追加候補: 軌道（レール種別と対荷重）

電化に続く「全部盛り」候補（2026-08-11 追記）。優先度は電化より下だが、
建設時の選択→速度/荷重の制約→保線コスト、という因果が電化と同型なので実装コストは読みやすい。

- **レール種別（何キロレール）**: 37kg / 50kgN / 60kg など。重いレールほど
  高価だが許容速度と許容軸重が上がり、摩耗（保線費）が減る
- **対荷重（軸重制限）**: 線路ごとの許容軸重を超える車両は入線不可
  （建設可否と同じ静的述語で判定できる。貨物や機関車を導入する際に効いてくる）
- 表現は「同一き電区間の容量ペナルティ」と同じく離散近似でよい。
  軌道破壊の連続シミュレーションはやらない

## 遠い将来の夢（絵空事メモ）

3D自前レンダラーであることを活かした長期候補。**当面のスコープ外**だが、
アーキテクチャ判断で扉を閉ざさないよう記録しておく。

- **乗客視点**: 列車に「乗って」車窓を眺めるカメラ。現行カメラは俯瞰直交投影
  （cameraState.ts）なので、透視投影カメラのモードを wgpu レンダラーに足す必要がある。
  `renderPos`/`trackPath.ts` の走行線上にカメラを置くだけなので sim 層は無改造で済む見込み
- **運転モード**: プレイヤーがマスコンを握って1列車を手動運転する。
  physics.ts の加速モデル・制動曲線がそのまま車両応答に使えるうえ、
  信号計画（signalling-plan.md）の ATS-P/ATC が「プレイヤーを守る装置」として
  初めて肌で分かるようになる——保安装置システムとの相性が非常に良い

## 軌間の決定事項（2026-08-11 決定）

- ノーマル/アドバンスド: **狭軌(1067mm)と標準軌(1435mm)の2種のみ**
- リアリスティック: 拡張ラインナップ（特殊狭軌762mm・馬車軌間1372mmを追加した4種）
- **改軌工事あり**（既存線路の軌間を費用を払って変換するツール。「あったら楽しい」判断）
- ルールフラグとしては `extendedGauges: boolean`（リアリスティックのみ true）で表現し、
  モード名では分岐しない原則を維持する

## 未決定事項

- き電区間の容量・変電所間隔の具体値（ゲームスケール上のセル数換算）
- 信号方式の選択肢の中身（PM5 の設計時に別メモを起こす）
- モード選択UIの置き場所（新規ゲームダイアログ内を想定）
- リアリスティックの電化以外の候補（建築限界・勾配と粘着・保線など）は
  電化全部盛りの完成後に改めて優先順位を付ける

## PM3 follow-up(0.5.0-Alpha-9a): デッドセクション標識の視覚表現

PM3(0.5.0-Alpha-7a)で導入したdc/ac電化境界(`isDeadSectionBoundary`)は
シミュレーション上は牽引力ゼロの惰行区間として機能していたが、視覚的な目印が
無く境界の位置がプレイヤーから見えなかった(PM3実装メモの残りfollow-up)。

配置ロジックを`render/deadSectionMarkers.ts`の`findDeadSectionMarkerEdges`として
切り出した(sim/three.js非依存の純関数)。線路(connections)で実際に繋がっている
dc/ac隣接セル境界だけを、E/SE/S/SWの4方向を正準として重複無く列挙する
(反対向きの4方向は隣接セル側から検出されるため走査しない。catenaryの間引きと
同じ「軸方向を正準化する」考え方)。

ジオラマとしては実物のデッドセクション標識(架線の死区間を示す白い矩形標板)を
模した、柱1本+標板1枚の低頂点数アセットを`trackGeometry.ts`の
`buildDeadSectionMarkerPart`で生成し、`railGeometry.ts`の
`buildRailNetworkGeometry`が地平の平坦区間(incline/坂は対象外、catenaryと同じ
スコープ判断)の境界にだけ焼き込む。`WebGpuTrackNetwork.tsx`のsurfaceチャンクへ
catenaryと同じ経路(色は`PALETTE.deadSectionMarkerPole`/`deadSectionMarkerBoard`)
で載せた。境界が存在しないマップでは何も生成されない。

架線の色分け(dc灰/ac青みがかったグレー、PM3実装済み)そのままで、境界の
コントラクトワイヤーを中立色に置き換える案は`buildCatenaryParts`の改修が
大掛かりになるためスコープ外にした(柱+標板だけで境界位置は十分視認できる)。

高架・地下(uppers境界)のデッドセクションは対象外(地平のみ)。必要になれば
`findDeadSectionMarkerEdges`をレベル別に拡張する形で追随できる。

TDD: `deadSectionMarkers.test.ts`で配置ロジック(重複無し・connections必須・
同一方式/非電化混在では検出しない・斜め方向も検出)を固定。ブラウザ実機
(アドバンスドモード、セーブ注入でdc→ac接続線路を作成)で境界セルに柱+白い
標板が描画されることを確認。
