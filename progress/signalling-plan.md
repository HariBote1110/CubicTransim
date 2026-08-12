# 信号システム計画（別軸選択・段階制）

状態: **S0はPM1(2026-08-11)時点で既定として正式に運用中。S1は0.5.0-Alpha-10aで実装済み。S2は0.5.0-Alpha-12aで実装済み。S3は0.5.0-Alpha-13aで実装済み**。
プレイモード計画（play-modes-plan.md の PM5）の詳細設計。2026-08-11 の設計会話を基に作成。
PM3(0.5.0-Alpha-7a)でこの節を追記: `rules.signalling`は既定値`'s0'`のまま4プリセット
全てで揃っており（gameRules.ts）、現行の予約(PBS)＋制動距離ベースの移動閉塞システム
（sim/simulation.ts・sim/reservation.ts・sim/physics.ts）が、下記で定義するS0（おまかせ・
CBTC風の移動閉塞）の実装そのものとして機能している。コード変更は不要（S0=現行挙動の
追認、というPM1時点の想定どおり）。S1（固定閉塞）以降は本ドキュメントの計画のまま
未着手。

## 方針

信号はプレイモード（ライト〜リアリスティック）とは**独立した別軸の選択**とする。
「電化は難しくても楽しめるが、信号システムはよくわからない」というプレイヤー
（＝本プロジェクトのオーナー自身）を基準に、**既定は Cities: Skylines 的な
「線路を引くだけで勝手にうまく走る」**とし、興味がある人だけ深い段階へ潜れるようにする。

## 段階定義（`SignallingRules` の値）

| 段階 | 名称案 | 挙動 |
| :--- | :--- | :--- |
| S0 | おまかせ（CBTC風） | 信号機の設置が一切不要。全線が移動閉塞相当で、列車は先行列車との距離だけを見て自動で間隔を詰める。**現行の予約＋制動距離システムがほぼこれ**なので、S0=現行挙動の追認から始められる |
| S1 | 固定閉塞 | 信号機を置いた区間だけが閉塞になる古典方式（OpenTTD風）。信号が無い区間は1閉塞扱い。単線行き違い・追い越しをプレイヤーが設計する楽しさが生まれる |
| S2 | 信号の種別 | 場内・出発・閉塞・誘導など信号機に役割が付く。停車場（駅構内）と駅間の区別が生まれ、構内配線の設計が意味を持つ |
| S3 | 保安装置 | ATS-S（ロング地上子で警報のみ→確認扱い）、ATS-P（パターン照査で自動ブレーキ）、ATC（車内信号・段階速度制御）、CBTC/ATACS（無線移動閉塞）を路線ごとに選んで敷設する |

- S0 と S3 の CBTC は挙動がほぼ同じ（移動閉塞）だが、意味が違う:
  S0 は「概念を隠している」、S3 の CBTC は「地上設備＋車上装置に投資して勝ち取る」。
  S3 では CBTC 化に費用がかかり、未対応車両は走れない。
- S3 の保安装置は**事故システムと接続する**（progress/accidents-and-platform-doors.md 参照）。
  ATS-S は冒進を完全には防げない（警報→確認で通過できてしまう）、
  ATS-P/ATC はパターンに当たると自動ブレーキで確実に止まる、という差を
  事故発生率の差として表現すると、上位装置へ投資する動機が自然に生まれる。

## 実装の考え方

- 現行 sim の走行制御は `physics.ts` の制動曲線と予約延長判定に集約されているので、
  信号段階は「予約をどこまで延長してよいか」の述語の差し替えとして実装できる見込み:
  - S0/CBTC: 先行列車の後端まで（現行どおり）
  - S1/S2: 次の停止信号まで（閉塞単位）
  - ATS-P/ATC: 停止点に対する照査パターン（既存の `brakingDistanceM` がそのまま使える）
- 速度制御と予約延長は必ず同じ制動距離の式を使うこと（CLAUDE.md の既存規約と同じ）。
- 信号の見た目（腕木・色灯・車内信号）は描画側の話なので後回しでよい。

## S1実装済み(0.5.0-Alpha-10a)

- **選択UI**: 新規ゲームダイアログの「プレイモード」行の下に「信号方式」行を追加
  (おまかせ/固定閉塞の2択、既定はおまかせ)。`App.tsx`の`SIGNALLING_OPTIONS`。
  選択値は`PLAY_MODE_PRESETS[selectedPlayMode]`へ`signalling`だけ上書きしてマージし
  `newGame`へ渡す。S2/S3のボタンはまだ出さない。
- **ブロックの定義(方向性の選択)**: 既存の信号(`signalDir`)は既に**方向つき**
  (`pathfinding.ts`が信号の向きと逆行する進入を拒否する)。しかしブロックの
  区切り自体は**方向を持たない無向グラフの連結成分分割**にした。方向ごとに
  別のブロック割当を持たせると「対向列車がいる区間へは自分は入れないが
  相手からは入れる」のような非対称が生まれ、単線行き違いの検証が複雑になる。
  信号そのものが既に進入方向を制約しているので、ブロック分割は無向で十分という
  判断(`src/sim/blocks.ts`冒頭コメント)。
- **ブロック索引**: `src/sim/blocks.ts`の`buildBlockIndex(railMap)`。
  - 信号セル(`signalDir`)を境界として、それ以外のtrackセル(rail/station/depot)の
    8近傍連結成分(相互にconnectionsビットが立っている=繋がっている、片側配線は
    無視)をブロックとする。
  - 信号セル自身は**どちらのブロックにも属さない**(`blockKeyOf`が`undefined`)。
  - 駅・車庫はブロックを分割しない(周囲のブロックへ合流)。
  - PM4のき電索引(`feeding.ts`)と同じ単純化として、**layer!==0(高架・地下)は
    常に`undefined`=S1のブロック制約の対象外**(follow-up、下記「既知の制約」参照)。
  - `useGameLogic.ts`が`feedingIndex`と同じ同期パターンで`railMap`変化時にだけ
    再計算し、`SimWorld.blocks`へ鏡写しする(セーブ対象外、railMapから毎回導出可能)。
- **予約延長の占有判定**: `src/sim/simulation.ts`の`ensureReservation`に
  `blocksSegmentEntry(world, rules, trainId, segment)`を追加。
  `rules.signalling==='s1'`かつ`world.blocks`があるときだけ、これから予約しようと
  しているセグメントが触れるブロックのいずれかを自分以外の列車が(予約テーブル
  経由で)保有していれば、`tryReserve`自体を試みずに待機する
  (`blocks.ts`の`blocksOccupiedByOthers`)。**制動距離の式(`brakingDistanceM`)は
  一切変更していない**——変えたのは「どこまで予約してよいか」の述語だけで、
  実際に止まる動作(速度制御)は既存のS0のコードパスをそのまま通る
  (CLAUDE.mdの「速度制御と予約延長は同じ制動距離の式を使う」規約を維持)。
  `rules.signalling!=='s1'`(S0・旧セーブ・デバッグシナリオ既定)では述語は常に
  `false`固定なので、S0の挙動はビット単位で変わらない。
- **信号が無い場合(1ブロック)**: 信号を1本も置かなければ、`buildBlockIndex`は
  接続された線路全体を1つのブロックにする。そのため2列車が同じ線路に
  同時に入ることはできず、片方が入っている間はもう一方が入口(区間の外)で
  待つ——「信号が要る」を体感させる狙いどおりの挙動を回帰テスト
  (`signalling-s1.test.ts`)で固定した。
- **単線行き違い(交換設備)**: 交換設備の両端に信号を置く既存の設計
  (`passing-loop.test.ts`)はS1でもそのまま機能する(`signalling-s1.test.ts`に
  同型シナリオをS1ルールで追加し、デッドロック検知つきで衝突なし・双方到着を確認)。
- **既知の制約・follow-up**:
  - ブロック占有判定は毎tick`world.reservations`全体を線形走査する(O(予約数)）。
    現状の列車数・マップ規模では問題にならないが、将来的に索引化の余地はある。

## S1フォローアップ: 高架・地下のブロック対応(0.5.0-Alpha-10b)

- 上記「高架・地下(layer!==0)はブロック分割の対象外」の単純化を撤去した。
  `src/sim/levelAdjacency.ts`(新設、`feeding.ts`と共有)の`neighboursAtLayer`が
  `pathfinding.ts`の`resolveEntryLayer`と同じ「進入ビットで相手側の層を決める」
  規則で隣接セル+層を返すため、`buildBlockIndex`はこれを使って地平・高架・地下を
  またぐ連結成分を1回のBFSで求める。坂(ramp)で地平から高架/地下へ登る区間は
  自動的に同じブロックへ合流する。
- 信号(`cell.signalDir`)は`construction.ts`の`applySignal`が地平の`connections`
  無しでは置けない構造上、常に地平限定の概念。そのため`isTrackNode`は
  `layer===0`のときだけ`signalDir`を境界として扱い、高架・地下ノードは地平の
  信号の有無に関係なくブロックが繋がる(`blocks.test.ts`「地平の信号は同じセルの
  高架/地下レベルのブロックを分割しない」で固定)。
- `blocksOccupiedByOthers`が使う予約キー正規表現(`RESERVATION_KEY_RE`)が
  負のlayer(地下、`x,z:u-1`のような形)を読めていなかったバグ(常に`NaN`→
  地平扱いに丸め込まれていた)も本フォローアップで発見・修正した。
  `reservationKey`(`reservation.ts`)の出力形式に地下ケースが無かったため
  これまで顕在化していなかった。
- ブラウザ実機(リアリスティックモード)で、地平のDC電化線路→坂→地下1の区間を
  実際にUIから建設し確認した(詳細はplay-modes-plan.mdのPM4フォローアップ参照。
  ブロック索引も同じ`levelAdjacency.ts`を使うため挙動は対称)。

## S2実装済み(0.5.0-Alpha-12a)

S1(固定閉塞)の上位互換として、信号にkindを付けS1の判定を精緻化する形で実装した
(ブロック分割自体はS1と完全に同じ、変わるのは「予約延長を許すか」の述語のみ)。

- **選択UI**: 信号方式行に「信号種別」(s2)を追加(`App.tsx`の`SIGNALLING_OPTIONS`)。
  `rules.signalling`は既存のv17セーブフィールドにそのまま`'s2'`が乗る(スキーマ変更不要)。
- **信号セルの種別**: `CellData.signalKind?: 'block' | 'home' | 'departure'`
  (`types.ts`)。未設定は`'block'`(=従来の閉塞信号)として扱う。ブロック分割
  (`buildBlockIndex`)は種別を見ない——signalDirを持つセルは種別に関わらず境界のまま
  (S1と同じ「方向つきだが分割は無向」の設計を継承)。
- **設置UI**: 信号ツールがアクティブかつ`rules.signalling==='s2'`のときだけ、GameUIに
  種別選択行(閉塞/場内/出発)を表示する(`軌間`行と同じスタイル)。`construction.ts`の
  `applySignal`が`kind`引数を受け取り、
  - 未設置セルへ新規設置: 指定したkindで置く(省略時は`undefined`=block扱い)
  - 既存信号へ**異なる**kindを指定: 向きは変えずkindだけ更新
  - 既存信号へ**同じ**kindを指定(=通常のクリック連打): 従来どおり向きを巡回
  という3分岐にした。Shift+クリックでの撤去(`removeSignal`)は変更なし。
- **S2の予約延長判定**: `simulation.ts`の`blocksSegmentEntry`を拡張。
  - `entrySignalKindFor(world, rt, startIdx)`が、これから取ろうとしているセグメントの
    先頭(`route[startIdx]`)が信号セルなら、そのセルの`signalKind`を返す
    (`isSafeWaitingPoint`の規則上、セグメントは必ず「信号セルそのもの」か
    「信号を経由しない安全点(駅・車庫・行き止まり)」から始まるため、これが
    「このセグメントへくぐって入る信号」になる)。
  - `rules.signalling==='s2'`かつ`entryKind==='home'`のときだけ、ブロック全体の
    占有チェック(`blocksOccupiedByOthers`)を**外す**。実際のセル排他は
    `tryReserve`が別途保証するため、「自分の経路セルが他列車の予約セルと重ならない
    限り入線できる」というper-track occupancyがそのまま実現できる——同一ブロックに
    属する複数のプラットフォームtrackへ、場内信号越しに複数列車が同時進入できる
    (駅構内配線が意味を持つ、というS2の設計意図どおり)。
  - `entryKind`が`'departure'`または`undefined`(種別無し信号・信号を経由しない安全点)
    のときはS1と同じブロック全体判定のまま。
  - 出発信号の「停車中はこの先を予約しない」は、既存の停車処理
    (`stopAtStation`が`rt.route = []`・`rt.reservedEndIndex = -1`にする)が
    そのまま満たしている——停車中はルートが空なので`ensureReservation`自体が
    早期returnし、出発信号の先を予約しようがない。発車後にensureReservationが
    出発信号越しのセグメントを要求する際は、通常のS2判定(entryKind='departure'→
    ブロック全体判定)が効くため、追加のフックは不要だった。
  - `rules.signalling==='s1'`のときは、signalKindが付いていても常にブロック全体判定
    (S1はkindを無視、既存のS1挙動はビット単位で不変)。
- **描画**: `render/signalGeometry.ts`の`buildSignalGeometries`が`kind`引数を取り、
  信号灯の色を種別ごとに変える(閉塞=緑・場内=青・出発=黄、既存の緑がデフォルト)。
  それ以外の形状は変更していない(小さな視覚的区別に留める設計判断どおり)。
- **テスト**: `signalling-s2.test.ts`。2進入線がクロスオーバーで1つのブロックに
  合流するレイアウトを使い、(1)場内信号経由なら別プラットフォームtrackへ2列車が
  同時進入できる、(2)種別無し信号は閉塞信号として振る舞いブロック全体で排他される、
  (3)S1配下ではsignalKind='home'が付いていても無視されブロック全体で排他される、
  (4)同じプラットフォームtrackを目指す2列車はhome信号越しでもセル排他で待つ、
  (5)出発信号越しの延長は停車中は行わず・発車後も先の区間(ghost予約)が空くまで待ち
  空けば進める、の5パターンを固定した。`construction.test.ts`にも`applySignal`の
  kind引数の3分岐(新規設置/kind変更/向き巡回)を追加。
- **ブラウザ実機確認**: `__debugWorld`へ上記と同型の2進入線+場内信号+クロスオーバーの
  シナリオを注入し、`__dbgStep`で2列車を同時に走らせ、両方が同じブロックの別
  プラットフォーム(stP1/stP2)へ同時に到達することを確認した(runtimes.grid/debugStatus
  ダンプで検証。描画チャンクはReact側railMap stateから作られるため、worldRef直接注入では
  画面には反映されない——これは`__debugWorld`注入の既知の制約であり、シミュレーション
  ロジックの検証はrutimesダンプで十分に行える)。

## S3実装済み(0.5.0-Alpha-13a)

S2(信号の種別)の上位互換として、「S2の判定をそのまま含み、CBTC(移動閉塞)のときだけ
ブロック全体判定をバイパスする」形で実装した(S1→S2と同じ「述語を差し替える」設計を継承)。

- **選択UI**: 信号方式行に「保安装置」(s3)を追加(`App.tsx`の`SIGNALLING_OPTIONS`、
  グリッドを2列→4列に変更)。
- **地上設備**: `CellData.protection?: 'ats-s' | 'ats-p' | 'atc' | 'cbtc'`(`types.ts`)。
  信号セル(`signalDir`)と同じセルに乗る想定(現実の信号機と保安装置の対応関係)。
  未設定は無防備。線路ツールがアクティブかつ`rules.signalling==='s3'`のときだけ、
  GameUIに保安装置選択行(なし/ATS-S/ATS-P/ATC/CBTC)を表示する(`軌間`行と同じスタイル)。
  `construction.ts`の`RailBuildOptions.protection`を、地平・高架・地下・坂の全ての
  セル生成パス(`addConnectionToCell`と`applyGroundPathWithElevatedConnect`/
  `applyElevatedPath`/`applyUndergroundPath`の各`gaugeElectrifiedPatch`)へ
  gauge/electrifiedと同じ「省略時は既存セルの値を保つ」規約で伝播させた。
  建設コストは`economy.ts`の`PROTECTION_COST`(ATS-S ¥10・ATS-P ¥30・ATC ¥60・CBTC ¥100、
  いずれも/マス)を`costOfProtection`で加算する(`useGameLogic.ts`の3箇所、電化コスト加算と
  同じ並び)。
- **車上装置**: `TrainData.protection?: TrainProtection`。車庫ツールが
  `rules.signalling==='s3'`のときだけ保安装置選択行を表示し、`buyTrain`が
  `trainCostForProtected(power, protection)`(`economy.ts`)で価格を決める。
  `PROTECTION_TRAIN_PRICE_MULTIPLIER`(ATS-S×1.05・ATS-P×1.15・ATC×1.30・CBTC×1.50)を
  動力方式ごとの基準額(`trainCostFor`、AC/ACDC倍率込み)へさらに乗算合成する
  (交流用CBTC車ならAC倍率×CBTC倍率が両方乗る)。
- **Effect A: SPAD(信号冒進)**: `simulation.ts`の`ensureReservation`が
  `blocksSegmentEntry`でtrueを返した(=停止信号への進入待ちに入った)瞬間、
  `evaluateSpadOnce`を呼ぶ。`rt.spadCheckedFor`(待機中の信号セルキー)で
  「同じ信号への待機中は1回しか判定しない」ラッチを実装し、待機が解消して
  次の予約に進んだら`undefined`へ戻す(次の別signalでまた判定できるようにする)。
  有効な保安装置は`economy.ts`の`weakerProtection(trackProtection, trainProtection)`
  (地上・車上のうち弱い方、未設定は'none'扱い)。確率テーブル`SPAD_CHANCE`は
  none 2%・ATS-S 0.5%・ATS-P/ATC/CBTC 0%(ATS-Sは警報のみで確認通過できてしまう、
  という設計意図どおり)。RNGは既存の事故システム(`progress/accidents-and-platform-doors.md`)
  と同じ`world.rng()`(本番`Math.random`、テストは固定値関数を注入)をそのまま使い回した
  (「stepWorldにRNGが無ければハッシュ導出」という代替案は不要だった。既に事故システムが
  `SimWorld.rng`を持っていたため)。当たった場合は既存の事故イベントパス
  (`SimEvent`の`accident`型、`rt.haltRemaining = ACCIDENT_HALT_DURATION`・
  `ACCIDENT_PENALTY`の賠償)をそのまま再利用し、`kind: 'spad'`で駅の人身事故と区別できる
  よう型を拡張した(`stationId`には駅名の代わりに信号の座標ラベルを入れ、
  `AccidentNotice`のバナー表示側で`kind`を見てメッセージを分岐する)。
- **Effect B: CBTC移動閉塞**: `blocksSegmentEntry`に`rules.signalling==='s3'`の分岐を追加。
  列車の保安装置が`'cbtc'`、かつこれから予約しようとしているセグメントの全セルが
  `protection==='cbtc'`(`segmentAllCbtc`)なら、S2のブロック全体判定を丸ごとバイパスして
  `false`を返す(=S0と同じ、`tryReserve`のセル単位排他のみが効く)。1セルでも無防備・
  他方式が混じっていれば通常のS2判定(ブロック全体占有チェック、`entryKind==='home'`の
  例外込み)にフォールバックする。「S0とS3-CBTCは挙動が同じだが意味が違う」という
  当初計画どおり、投資(地上+車上のCBTC化)によって移動閉塞を"取り戻す"形になっている。
- **s0/s1/s2は無変更**: `blocksSegmentEntry`のs1/s2分岐、既存のS1/S2テストは変更していない
  (`rules.signalling==='s3'`の分岐は既存分岐の後に独立して追加した)。
- **テスト**: `signalling-s3.test.ts`。(1)無防備同士でのSPAD発生+1approachにつき1回のラッチ、
  (2)ATS-P同士ならSPAD確率0で事故が起きない、(3)weaker-ofの検証(地上ATCでも車上が
  無防備なら無防備扱いでSPADしうる)、(4)`weakerProtection`/`SPAD_CHANCE`の純関数テスト、
  (5)全セル+両列車CBTCならブロック全体判定をバイパスして2列車が同一ブロックへ
  同時進入できる(S1テストと同型の経由駅つきレイアウトで、両方が同時に区間内側にいる
  瞬間を観測)、(6)CBTC区間でなければS3でもS1/S2と同じくブロック全体排他になる、
  (7)地上/車上コスト定数の検証、の9ケースを固定した。
- **ブラウザ実機確認**: 新規ゲームで信号方式=保安装置を選択→線路ツールに保安装置行
  (なし/ATS-S/ATS-P/ATC/CBTC)が出ることを確認、CBTCを選んで線路を敷設し
  `__debugWorld.railMap`の該当セルに`protection:"cbtc"`が付くこと・追加費用が
  加算されること(4マス×(¥100+¥100)=¥800)を確認、車庫ツールでも同じ保安装置行が
  出ることを確認した。
- **既知の制約・follow-up**:
  - 既存の保安装置セルへ後から保安装置だけを変更する「アップグレードツール」は
    実装していない(改軌ツールと同じパターンを流用できる見込みだが、選択肢が
    増えるとUIが煩雑になるため今回は見送った)。現状は敷設時にしか選べない。
  - `evaluateSpadOnce`は`entryKind`(信号の種別)がある場合のみ判定する。安全点が
    駅・車庫・行き止まりのみで信号セルを経由しない待機(=閉塞境界にそもそも信号機が
    無いケース)ではSPAD自体を判定しない設計にした(現実の信号冒進は「信号機を
    冒進する」行為であり、信号の無い待機に適用する概念ではないため)。

## 未決定事項

- S1 の信号機は現物の「信号」建設物（キー5）を流用するか、置き直しか
- 段階を路線ごとに選べるようにするか、世界で1つか（保安装置は路線ごとが自然）
- 誘導障害（交流電化と信号回路の干渉）のような電化×信号のクロス要素を
  リアリスティック×S3 の組み合わせ限定で入れるか（面白いが後回し）
