# レビュー: feature/stopping-and-diorama-visuals (698fee9..HEAD)

対象: プレイモード PM1-PM4(軌間・電化・交直流・き電)、信号 S1-S3、軌道(何キロレール)、
および描画まわりの修正。`git diff 698fee9...HEAD`(65ファイル、+6682/-254)。
判定基準は CLAUDE.md・progress/play-modes-plan.md・progress/signalling-plan.md。

**このファイルはレビュー成果物であり、コミットしていない。修正は一切行っていない。**

---

## 重大度: 高

### H1. 建設プレビューが保安装置(S3)の費用を加算せず、実課金と食い違う

- `src/sim/buildPreview.ts:250-259`(`cost` の組み立て。`costOfProtection` を import すらしていない)
- 対する実課金: `src/hooks/useGameLogic.ts:352-354` / `:369-370` / `:379-380`(地平・高架・地下の3経路すべてで `cost += costOfProtection(path.length, railOptions.protection)`)

**欠陥**: `evaluateBuild` はレール種別倍率と電化費だけを載せ、S3 の地上設備費 (`PROTECTION_COST`、
CBTC で ¥100/セル) を落としているため、GUI が表示する見積りが実際の課金より安い。

**具体的な失敗シナリオ**: 信号方式=保安装置のゲームで、線路ツールに CBTC を選び 20 セルを敷こうとする。
所持金 ¥2,500。プレビューのコストは `20×100 = ¥2,000` で `reason:'ok'`(緑表示)になるが、
`commitPath` の実コストは `¥2,000 + 20×¥100 = ¥4,000` で `if (money < cost) return;` に落ちる。
**線路は1セルも建たず、UI にはエラーも出ない**(黙って何も起きない)。
これは CLAUDE.md の「UIに条件を書き写さず construction.ts の apply 系に問い合わせる」=
単一の可否判定源、という規約が保安装置ぶんだけ破れている状態。

### H2. `railOptions` がプレイモードから独立して生き残り、ライトモードへ漏れる

- `src/App.tsx:141` `useState<RailBuildOptions>({ gauge: 1067 })` — newGame/loadGame でリセットされない
- `src/hooks/useGameLogic.ts:349-355`(および高架 `:367-370`・地下 `:377-380`)— `gameRules` を一切見ずに
  `railOptions.electrified` / `.protection` / `.railWeight` をコスト・セル生成へ適用する
- `src/components/GameUI.tsx:184/242/263` — UI は行を**隠すだけ**で state をクリアしない

**欠陥**: 選択状態はグローバルな React state であり、ルールが変わっても保持されるため、
概念が存在しないはずのモードで電化・保安装置・レール種別が書き込まれ、課金される。

**具体的な失敗シナリオ**: リアリスティックで遊び、線路ツールで「交流」「60kg」「CBTC」を選択する
→ 新規ゲームで**ライト**を選ぶ → 線路を10セル敷く。
`cost = 基本×1.3 + 電化費¥500 + CBTC費¥1,000` が課金され、セルには
`electrified:'ac'`・`protection:'cbtc'`・`railWeight:60` が書き込まれる。
描画側 (`railGeometry.ts:145`) は `data.electrified` だけを見るので、
**軌間も電化も存在しないはずのライトモードの世界に交流色の架線が生える**。
「ライト=現行仕様・挙動変更ゼロ」というPM1の中心的な保証がここで破れている
(sim 側の述語は正しくゲートされているのに、UI→建設の経路だけが素通し)。

### H3. S2 の場内信号バイパスがブロック種別を問わず無条件で、S1 の保護を丸ごと外す

- `src/sim/simulation.ts:281` `if (entryKind === 'home') return false;`

**欠陥**: 場内信号をくぐるセグメントは、**そのブロックがどんなブロックであっても**
ブロック全体占有チェックを完全に外す。signalling-plan.md の意図は「駅構内の複数ホームへ
同時進入できる」ことだが、実装は「駅構内かどうか」を一切見ていない。

**具体的な失敗シナリオ**: 単線区間(信号なし=1ブロック)の両端の駅に、プレイヤーが自然に
「場内信号」を置く。東行き列車 A と西行き列車 B が同時に発車する。両者とも `entryKind==='home'`
なので S1 のブロック排他が効かず、`tryReserve` のセル単位排他だけになる。A は東側半分、
B は西側半分のセルを予約して中央で向かい合い、互いに相手の保有セルを待つ**恒久デッドロック**
に入る(デッドロック解消機構は存在しない)。S1 なら「片方が入口で待つ」で正しく回避できた
状況が、信号に種別を付けた途端に壊れる。
最低限、`home` 例外は「そのブロックが駅セルを含む」等の条件で絞るべき。

### H4. 改軌の在線判定が列車の実位置を見ていない

- `src/hooks/useGameLogic.ts:392` `const occupiedCells = new Set(worldRef.current.trains.map(t => toKey(t.x, t.z)));`

**欠陥**: `TrainData.x/z` は**車庫での初期位置**であり、走行中は更新されない
(`simulation.ts:335` で `TrainRuntime.grid` の初期値として読まれるだけ。`setTrains` で位置を
書き戻す経路は存在しない — `useGameLogic.ts` の `setTrains` 呼び出しはすべて schedule/cars/status 更新)。
走行中の実位置は `worldRef.current.runtimes.get(id).grid`。

**具体的な失敗シナリオ**: 列車を車庫 (0,0) から出庫させ、(20,0) 付近を走らせる。
改軌ツールで (20,0) を含む区間を 1435mm へ改軌すると、`occupiedCells` には (0,0) しか
入っていないため **no-op ガードが働かず改軌が通る**。次tickの経路探索で
`cellAllowsTrain` が軌間不一致で false を返し、走行中の列車が経路を失って現地で立ち往生する
(`applyRegaugePath` のドキュメントコメントが約束している不変条件が、呼び出し側で満たされていない)。
なお `buildPreview` 側 (`GameUI.tsx:304`) は `occupiedCells` を渡してすらいない(常に空集合)ので、
プレビューと実際の可否も一致しない。

---

## 重大度: 中

### M1. 軌道の非常制動分岐が `rules.trackClasses` で囲われておらず、下位モードの数値挙動を変える

- `src/sim/simulation.ts:1152-1159`

`else if (rt.speedKmh > hardEnvelopeKmh)` は新設分岐だが、`hardEnvelopeKmh` は
`trackClasses=false` でも従来からの `sqrt(2ad)` 値を持つため、条件は全モードで成立しうる。
`permittedSpeedKmh ≤ sqrt(2ad)` なので `speed > hard ⟹ braking===true` が保証されており、
速度そのものの計算結果 (`max(hard, v - EMERGENCY·dt)`) は従来の制動分岐内のクランプ
(`:1193-1195`) と一致する。**しかし `rt.brakeDecelMs2` の扱いが違う**: 従来は
`rampDecel()` でジャーク制限しながら近づけていたのに対し、新分岐は `serviceDecelMs2` を
即座に代入する。`rt.brakeDecelMs2` は次tickの `rampDecel` の起点なので、以後の減速プロファイルが
わずかにずれる。

**失敗シナリオ**: ライトモードで、先行列車の急な停止により予約末端が縮んで
`hardEnvelope` を割り込んだ列車。従来はジャーク制限つきで減速度を立ち上げていたのが、
今は 1 tick で常用最大まで飛ぶ。「下位ティアはビット単位で不変」という本ブランチの
明示的な保証に対する違反(影響は小さいが、保証としては破れている)。
分岐全体を `rules.trackClasses` で囲うか、`hardEnvelopeKmh` とは別の
`railHardEnvelopeKmh` を持たせるのが筋。

### M2. き電オーバーレイの再構築署名が在線数の変化を検出しない

- `src/components/WebGpuFeedingOverlay.tsx:113` `` `${railSignatureOf(railMap)}#${feedingSectionCounts?.size ?? -1}` ``

署名に入っているのは Map の **size(在線列車がいる区間の数)** だけで、区間ごとの**値**ではない。

**失敗シナリオ**: 容量3の区間に電車が3本いる(overload でない)状態でオーバーレイを開き、
4本目が同じ区間に入る。`feedingSectionCounts` の size は 1 のまま変わらないので署名が一致し、
`return` して再構築されない。**容量超過になっているのにオーバーレイは緑のまま**で、
プレイヤーは変電所の増設が必要なことに気づけない(この可視化機能の唯一の存在意義が失われる)。

加えて `railSignatureOf` は railMap 全体を走査して文字列を組み立てる処理を**毎フレーム**行う
(変電所ツール使用中)。16K マップ規模では毎フレームの O(railMap) 文字列連結になる。

### M3. 容量超過判定が2箇所に別実装で、条件も食い違う

- `src/sim/simulation.ts:611-613` `if (count > capacity) tractionFactor = OVERLOAD_ACCEL_FACTOR;`
- `src/render/feedingOverlay.ts:56-59` `if (capacity > 0 && count > capacity)`

同じ「区間が容量超過か」の述語が sim と render に二重実装され、しかも `capacity > 0` の
有無で結果が変わる。変電所が1つも繋がっていない区間 (capacity=0) に電車が残っている場合、
sim は牽引力を半減させるが、オーバーレイは 'powered'(超過なし)を表示する。
`FeedingIndex` に `isOverloaded(sectionKey, count)` を1本生やして共有すべき箇所。

### M4. レール速度上限のループが3重、しかも O(route²)

- `src/sim/simulation.ts:382-406`(`railApproachCapKmh`)、`:1106-1120`(hardEnvelope)、`:1174-1186`(requiredDecel)

同じ「`rt.route` を全走査して各セルの `railWeightSpeedCapKmh` と
`distanceAlongRouteTo(rt, i) - RAIL_CAP_APPROACH_MARGIN_M` を求める」ループが3箇所に複製されている
(現在セルの上限も `railApproachCapKmh:391` と `:1109` で二重に扱っている)。
さらに `distanceAlongRouteTo`(`:378` 付近)は `idx` まで線形に足し込むので、
ループ全体は列車1本1tickあたり **O(3·n²)**(n=残り経路長)。長距離運行では経路が数百セルに
なりうるため、リアリスティックモードでのみ支配的なコストになる。
「距離とcapの配列を1回だけ前計算し、3つの制約式がそれを共有する」形にまとめるべき。

### M5. 地下ランプ dir 正規化がセーブ版数で区切られておらず、毎ロード実行される

- `src/sim/persistence.ts:503-532` `normaliseUndergroundRampDirs`

修正コミット 91f5945 以前のセーブを直すための移行処理だが、版数(v17かどうか、あるいは
セーブ時刻)で区切られておらず、**修正後に書かれた正しいセーブに対しても毎回走る**。
判定は隣接セルの接続状態からの構造推定 (`!dirMatches && oppMatches`) なので、
坑口・分岐など「高い側の隣接セルが接続ビットを持たない」形状では正しい dir が反転されうる。
一度反転されるとセーブし直されて固定化する。移行処理は必ず版数で区切り、
新形式には触れないのが安全側。

### M6. `gaugeElectrifiedPatch` が5箇所にコピーされている

- `src/sim/construction.ts:47-52`(addConnectionToCell)、`:140-145`(anchor)、`:168-173`(ramp)、
  `:1230-1235`(applyElevatedPath)、`:1367-1372`(applyUndergroundPath)

`{...(options.gauge !== undefined ? {gauge} : {}), ...}` という同一の4フィールド構築が
文字通り5回書かれている。フィールドを1つ足すたびに5箇所を直す必要があり、
実際 `protection` と `railWeight` の追加でその5箇所修正が発生している(diff から確認できる)。
`const railOptionsPatch = (o: RailBuildOptions) => ({...})` 1本に括るべき典型例。

### M7. `DEFAULT_GAUGE` / `DEFAULT_RAIL_WEIGHT` があるのにリテラルが散在

`src/types.ts:18/29` に定数を定義しておきながら、実際に使っているのは
`gameRules.ts` と `trackGeometry.ts` だけ。以下はすべてリテラル:

- `src/App.tsx:141` `{ gauge: 1067 }`、`:142` `useState(1067)`
- `src/hooks/useGameLogic.ts:461` `depotCell?.gauge ?? 1067`
- `src/sim/pathfinding.ts:250` `trainGauge = 1067`
- `src/sim/simulation.ts:911` / `:956` `train.gauge ?? 1067`
- `src/sim/construction.ts:399` / `:1799` `cell.gauge ?? 1067`
- `src/components/GameUI.tsx:304/570/718` `?? 1067`
- `src/sim/physics.ts:72` `RAIL_WEIGHT_SPEED_CAP_KMH[weight ?? 50]`、`src/sim/economy.ts:135` `[weight ?? 50]`

軌間ラインナップを変える(plan には将来構想として記載あり)ときに全箇所を追う羽目になる。

---

## 重大度: 低(AI由来のノイズ)

### L1. 到達不能な防御コード — `applySubstation` の自セル電化チェック

`src/sim/construction.ts:193-200` の `hasAdjacentElectrifiedRail` は先頭で
「自セルが電化 rail なら true」を見るが、呼び出し元 `:218` が
`if (existing) return state;` で**既存セルがあれば必ず先に return する**ため、
`self` は常に `undefined`。5行まるごと死んだコード。

### L2. `applySignal` の冗長スプレッドと、s0/s1 への `signalKind` 書き込み

- `src/sim/construction.ts:254` `railMap.set(key, { ...cell, signalDir: nextDir, signalKind: cell.signalKind });`
  — `...cell` に既に含まれており無意味。
- `src/App.tsx:144` の `signalKind` 既定 `'block'` が `commitPath` 経由で常に渡るため、
  s0/s1 のワールドでも新設信号に `signalKind:'block'` が書き込まれる。挙動は変わらないが
  「s2 未満では種別の概念が無い」という設計意図と、セーブの素直さが崩れる。

### L3. 過剰防御 + 自己矛盾コメント

`src/sim/gameRules.ts:93-100` の `electrificationOf` は
「persistence で正規化しているが、念のためここでも防御的に扱う」と書きつつ、
実際に `true` を受ける経路(テスト・デバッグシナリオ)が現存するため防御が必要になっている。
不変条件が「正規化済み」なのか「正規化されていないことがある」のかが文書上あいまい。
デバッグシナリオ側を `'dc'` に揃えて、この関数の受け入れ型から `boolean` を落とすのが本筋。

同様に `src/sim/gameRules.ts:118-120` の
「'modes'段階は 'ac' を書き込まない前提だが、念のため同じ判定式を使い回す」も
不変条件を主張しながらそれを信用しない書き方。

### L4. `stallRecovered` のリセットが加速分岐でしか起きない

`src/sim/simulation.ts:1220-1222` — `!inDeadSection` によるリセットは
「制動不要 かつ `speed < releaseEnvelope`」の分岐の中にしかない。
デッドセクションを抜けた直後にそのまま制動へ入り、駅に停まってから次の境界へ
低速で近づくケースでは `stallRecovered` が true のまま残り、**2つ目のデッドセクションで
失速判定がスキップされる**(救援課金も発生しない)。実運用ではたいてい途中で加速分岐を
通るので顕在化しにくいが、リセットは分岐の外(位置更新の直後)に置くべき。

### L5. 実装式をそのまま照合しているテスト

- `src/sim/signalling-s3.test.ts:228-229` `expect(costOfProtection(3,'ats-s')).toBe(3 * PROTECTION_COST['ats-s'])`
- `:237-238` `expect(trainCostForProtected(...)).toBe(Math.round(TRAIN_COST * PROTECTION_TRAIN_PRICE_MULTIPLIER[...]))`
- `:132` `expect(weakerProtection('ats-p','atc')).toBe('ats-p')` — コメント自身が
  「同rankなのでどちらでも良い」と言っており、任意のタイブレーク実装を固定している

いずれも実装を書き写しているだけで、定数を変えてもテストは追随して通る=回帰を検出しない。
仕様値(例: `SPAD_CHANCE['ats-p'] === 0`)の固定は妥当だが、掛け算の再実行は不要。

### L6. コメント汚染(レビュア向けの経緯説明が残っている)

- `src/sim/blocks.ts:120-121` 「旧正規表現は `\d+` のみで負の層(地下)を読み違えていた」
- `src/components/WebGpuFeedingOverlay.tsx:34-37` / `:57-61` 「実機検証で発覚」
- `src/sim/construction.ts:70` 「省略時は既存挙動と完全に同一(gaugeElectrifiedPatchが空になる)」など、
  同趣旨の「挙動は変わらない」注記が構築系5箇所に重複

不変条件(なぜこの形式なのか)ではなく「以前はこうだった/このコミットで直した」という
履歴の説明で、progress/ と git log の役目。sim/render のコードからは落として構わない。

### L7. 既存の性能ガードテスト2件が落ちる(本ブランチとは無関係)

`npx vitest run` の結果は 1140 passed / 3 failed。落ちているのは
`src/sim/towns.test.ts:456`(<900ms)と `:631`(<1500ms、実測1934ms)、および
同ファイル内のもう1件で、いずれも町生成の実行時間ガード。本ブランチの変更点とは無関係の
マシン速度依存だが、CI 相当のグリーンが取れない状態は放置しないほうがよい。

---

## 問題なしと確認できた箇所(clean bill)

優先確認領域について、実際のコードパスを追って健全と判断したもの:

1. **ライトモード/下位ティアへの述語漏れ**(M1 を除く)
   - `pathfinding.ts:305-320`: `cellAllowsTrain` は `rules.gauge=false` / `electrification='none'` で
     無条件 true に短絡し、き電判定は `rules.electrification==='feeding' && trainPower!=='diesel' && feeding`
     の三重ゲート。ライトでは `world.feeding` を渡しても評価されない。
   - `simulation.ts:1440-1454`: `feedingSectionCounts` は `rules.electrification==='feeding'` のときしか
     作られず、`stepTrain:608` の `tractionFactor` はその Map の存在を条件にしているので、
     下位ティアでは常に 1。
   - `simulation.ts:275-284`: `blocksSegmentEntry` は s0 で必ず `false`。`world.blocks` は常に
     計算・鏡写しされるが誰も読まない。
   - `gameRules.ts:145-153` `axleLoadAllowed` は `trackClasses=false` で常に true、
     `railApproachCapKmh:389` も `Infinity` 即返し。
   - 漏れは「sim 層の述語」ではなく「UI→construction の建設オプション経路」(H2)のみ。

2. **予約 / ブロックの相互作用**
   - 停車中の列車は `reservePlatform`(`simulation.ts:373-380`)でホーム全セルの予約を保持し続けるため、
     `blocksOccupiedByOthers` が「予約テーブルだけを見る」設計でも**停車中の列車を取りこぼさない**。
     `ensureRuntime:356-362` の trail からの遅延再構築も同様に、ロード直後の物理占有を予約へ補完する。
   - S1 のブロック待機は `return` するだけで予約を取らないので、予約リーク(取ったまま放置)は無い。
   - `blocks.ts:120` の `RESERVATION_KEY_RE = /^(-?\d+),(-?\d+)(?::u(-?\d+))?$/` は
     `reservation.ts` の `reservationKey` の出力形式(地下=負の layer)と整合しており、
     以前の `\d+` バグは正しく直っている。
   - S3 の CBTC バイパス (`simulation.ts:280`) は「セグメント全セル cbtc **かつ** 自車 cbtc」の
     二重条件で、1セルでも欠ければ S2 判定へフォールバックする。挙動は S0 と同値であり、
     S0 が既に持っているデッドロック特性以上のものは持ち込まない(H3 の home 例外とは事情が異なる)。

3. **レール速度上限の制動統合(数式面)**
   - `railApproachCapKmh:397-402` の「距離 d 先で目標速度 cap に落とす」を
     「d + brakingDistanceM(cap) 先で停止する」へ還元する変換は正しい:
     `brakingDistanceM`(`physics.ts:140-145`, `d = v²/2a + v·a/(2j)`)は
     `permittedSpeedKmh`(`:119-133`, `currentDecel=0` すなわち `k = a/(2j)`)の厳密な逆関数なので、
     この置換で式が完全に整合する。`CLAUDE.md` の「速度制御と予約延長は同じ制動距離の式を使う」規約も
     維持されている(制動距離の式自体には手を入れていない)。
   - `RAIL_CAP_APPROACH_MARGIN_M = 5` は停止点用の `BRAKING_MARGIN_M = 0.5` とは別定数として
     切られており、両者を混同していない。1 tick の進行 (dt=0.1s, 100km/h で 2.8m) を包含する値として妥当。
   - デッドセクション惰行 (`computeAcceleration` の `'coasting'`) は既存の抵抗項の再利用で、
     `tractionFactor` は牽引力側にのみ掛かる(`physics.ts:50`)。惰行・制動には掛からないので、
     過負荷と惰行が同時に起きても二重に減速することはない。

4. **永続化のラウンドトリップ・legacy 正規化**(M5 の版数区切りを除く)
   - `persistence.ts:256-262`: `electrified === true → 'dc'` の正規化は
     `'ac'`/`'dc'`/`undefined` をそのまま通す形で、`gameRules.electrificationOf` の解釈と一致。
   - `:280-282`: `rules` はオブジェクト自体の欠落(v15/v16)で `DEFAULT_GAME_RULES`、
     存在する場合もフィールド単位で `extendedGauges`/`trackClasses` を補完しており、
     PM1〜PM2 の途中版セーブが壊れない。`gauge`/`electrification`/`signalling` は
     v17 の初版から必ず存在するので補完不要という判断も正しい。
   - `serialiseWorld` の引数末尾に `rules` を足す形なので、既存呼び出し(テスト等)は
     既定値 `DEFAULT_GAME_RULES` で通る。

5. **き電索引の無効化タイミング**
   - `useGameLogic.ts:215-224`: `feedingIndex` は `useMemo([railMap])`。変電所は
     `railMap` のセル (`type==='substation'`) として持つので、**変電所の増減も railMap の
     参照差し替えを伴い**、依存配列は正しい(別 state になっていない)。
   - `SimWorld` への鏡写しは `useEffect`(commit 後)で行われ、`stepWorld` は共有 rAF ループの
     simulation フェーズ、すなわち commit 後のフレームで走るため、索引が1フレーム古くなる
     ケースは無い。`blockIndex` (`:230-236`) も同じパターン。
   - `buildFeedingIndex` の給電範囲 BFS は「同一変電所が同一セクションへ複数の隣接セルから
     繋がっても容量1台ぶん」を `touchedSections` の Map で正しく1回に畳んでいる。

6. **`levelAdjacency.ts` への抽出**
   - `pathfinding.ts` の `resolveEntryLayer` / `activeConnections` を
     `entryLayerCandidates` / `activeConnections` として切り出し、`feeding.ts`・`blocks.ts` が
     同じ隣接規則を共有する形は、まさに重複実装を潰す正しい方向のリファクタ。
     方向つき探索(prevLayer による絞り込み)と無向な連結成分分割の違いも
     ファイル冒頭コメントで明示されている。
