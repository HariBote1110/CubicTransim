# 16Kマップ対応の基盤構成

## Decision

最大 16384×16384(≒2.7億セル)を成立させるため、地形の持ち方を「全セル実体化」から
**「決定的な純関数 + 疎な編集差分」**へ転換する。リリース前でセーブ互換は破壊してよい
(ユーザー明言)ため、migrationは書かず v15 で作り直す。

1. **基底地形は保存しない**: `heightAt(seed, x, z)` を純関数にし、必要なセルだけ都度計算する。
   2.7億セルをメモリに持たない(現行 string-key Map は 2048² で実測442MB、16K² では数十GBで破綻。
   map_scale_research/notes/generation-scaling.md 参照)
2. **1-Lipschitz を「構成で」保証する**: 現行の normaliseHeights(全域2パス距離変換)は
   チャンク独立生成と両立しない。ノイズの各オクターブの振幅×周波数の合計勾配が
   量子化後に段差1以下へ収まるようパラメータで縛り、グローバル正規化パスを廃止する。
   保証はプロパティテスト(ランダム窓の全隣接ペア検査)で担保
3. **水域もローカル決定**: ランダムウォーク湖(グローバル逐次)をやめ、低周波ノイズの
   閾値による盆地=水域へ変更。どのセルも近傍参照なしで water 判定できる
4. **編集(盛土/切土)は差分オーバーレイ**: チャンク(64×64セル)単位の疎ストアに
   上書き値を持つ。`heightAt` はオーバーレイ→基底の順に引く。セーブは seed + mapSide + 差分のみ
5. **描画はチャンク方式**: カメラ可視範囲±マージンのチャンクだけジオメトリを構築・LRUで破棄。
   描画コストをマップサイズ非依存(可視セル数のみ)にする。建設・地形編集の再マージも
   チャンク単位になり、既存の「全再マージのヒッチ」懸念も同時に解消
6. **町は領域ベースの決定的配置**: グローバルな「8個ループ」をやめ、128×128領域ごとに
   seed から候補1点を導出しノイズでゲート。可視領域・近傍領域だけ実体化する

## 追記: コーナー格子を一次データにする(勾配レール対応の前提)

ユーザー要望により OpenTTD 流の「任意標高への建設(勾配レール・段丘上の駅)」を正式スコープに
追加。これに備え、terrainField の一次データを**セルのスカラー標高ではなくコーナー格子
(頂点標高)**にする。OpenTTD と同じく、タイルの形状は4隅のコーナー標高から導出し、
隣接コーナーの段差は1以下(急斜面の例外は当面導入しない)。

- `cornerHeightAt(x, z)` が一次(Lipschitz保証・プロパティテストはこの格子に対して)
- `cellHeightAt = min(4隅)` を互換ヘルパとして提供(現行の min 則コーナー導出と整合、移行期の消費側用)
- water はセル4隅すべて0の平坦セルのみ

## 実装フェーズ

- P1: `sim/terrainField.ts` 新設(純関数 heightAt/terrainAt、Lipschitz構成保証、水域ノイズ)
- P2: 編集オーバーレイ(チャンク疎ストア)+ terrainEdit の載せ替え
- P3: 消費側(construction/towns/tunnel/townTiles/buildPreview 等)の heights Map → field 移行、persistence v15
- P4: TerrainBlocks → チャンク描画コンポーネント(可視集合・キャッシュ・編集時再構築)
- P5: Scenery/TownBlocks のチャンク化と領域ベース町配置
- P6: generateMap/normaliseHeights 系の旧経路削除、デバッグシナリオ更新
- P7: 標高上の建設(OpenTTD流)— 勾配レール、段丘上の線路・駅、基礎(foundation)、
  MOUNTAIN_HEIGHT_THRESHOLD=1 の「標高0だけが可住」制約の撤廃。詳細仕様は
  openttd-slope-notes.md を参照して別途設計する
- P8: 地下線・地下駅(ユーザー要望)。既存の多レベル高架(uppers: 1..3)をレベル一般化して
  負のレベル(-1..-3等)へ拡張する方針。高架で確立済みの「レベル別connections・層別予約キー・
  レベル遷移の坂」の仕組みをそのまま下方向へ対称に使う。論点: (a) 地表からの出入りは
  ramp(掘割)か坑口直下型か (b) 描画は地下ビュー切替(A列車/Simutrans方式)か
  地表半透明カットアウェイか (c) 地下は町タイル・地形の制約をほぼ受けない代わりに
  建設費を高くする(OpenTTDのトンネル8倍コストの既存慣行に接続) (d) 標高のあるセルの
  地下(=現行トンネル)との整合。P7 のレベル/高さモデル設計と同時に決めるのが得策

## Alternatives considered

- **Rust/Go 別エンジン**: 棄却。実測(map_scale_research)により、破綻要因は言語ではなく
  「文字列キーMap」と「全セルジオメトリマージ」。ネイティブ化しても同じ方式なら同じく破綻する
- **Int8Array 全域実体化**: 16K² で 268MB+周辺配列。動きはするが起動生成が外挿~10分で不成立。
  純関数化なら生成時間ゼロ(初回アクセス時に都度)
- **normaliseHeights のチャンク適用**: 境界でLipschitz破れが出るため棄却。構成保証に切替

## Constraints / Gotchas

- 段差1以下の保証がノイズパラメータに依存するため、**振幅・周波数を変えるときは必ず
  プロパティテストを回す**こと(パラメータがテストの前提)
- terrainEdit の伝播BFSはオーバーレイ上で動くが、基底値との境界でも段差1を維持する必要がある
  (編集チャンクの縁は基底 heightAt と接する)
- 旧セーブ(v14以前)は読み捨てる(リリース前・ユーザー了承済み)

## P1実装メモ(sim/terrainField.ts)

- `createTerrainField(seed, halfExtent)` が `cornerHeightAt`(頂点格子・一次データ)/
  `cellCornerHeights`/`cellHeightAt`/`terrainTypeAt` を返す(上記「コーナー格子を一次データに
  する」追記を反映した最終形)。terrain.tsの`generateHeights`と同じ「フラクタル値ノイズ
  (smoothstep双線形補間)+平地バイアス+HEIGHT_GAIN」構成だが、normaliseHeights(全域2パス
  距離変換)を使わず、オクターブの振幅/波長そのものから1-Lipschitzを導く: smoothstepの
  最大傾き1.5と各オクターブの波長から連続場の勾配上界を計算し
  (`Σ (amp_i/AMPLITUDE_SUM) * 1.5/wave_i`)、HEIGHT_GAINをその逆数未満に選ぶことで、
  丸め後も隣接差1以下になることを保証する(「1-Lipschitzな連続関数を最近接整数に丸めても
  隣接差は1以下」という事実に依拠。詳細な式はterrainField.ts内のコメント参照)。
  1-Lipschitzの保証・プロパティテストはこのコーナー(頂点)格子に対して行う
- オクターブのシードはrngの逐次状態ではなく `deriveOctaveSeed(seed, index)`(murmur3風
  finalizer)で純粋に導出する。これによりcornerHeightAtがどの頂点からでも同じ結果を出せる
  (チャンク非依存性の要件)
- 水域はセルの4隅すべてが「同一の合成ノイズ場でWATER_THRESHOLD未満の頂点」であることで判定する
  (`isWaterVertex`)。WATER_THRESHOLD < FLATLAND_THRESHOLDなので、水域は必ず4隅とも標高0の
  完全に平坦なセルになり、湖の縁も平地フロアの内側に必然的に収まる
- 範囲外(|x|または|z| > halfExtent)は常に頂点標高0('grass'/標高0)(境界との連続性は
  保証しない、という設計判断。コメントに明記)
- テストは決定性・値域・cellCornerHeightsの並び([nw,ne,sw,se])・cellHeightAt=4隅min・
  水域/山岳の整合・範囲外・頂点格子上の1-Lipschitz(遠方x≈8000やチャンク境界64の倍数を
  含む散らばった64×64窓)・平地優勢の分布・性能ガード(50ms)をカバー
- terrain.ts/hooks/componentsへの配線はまだ行っていない(このフェーズはadditiveのみ)

## P2実装メモ(sim/terrainOverlay.ts)

- `CornerDiffs = Map<chunkKey, Map<localIndex, height>>`。チャンクは頂点座標を
  `OVERLAY_CHUNK_SIZE`(=64)で床除算した `cx,cz` 単位。Int8Arrayではなくper-chunk Mapを
  選んだ理由: 1回の編集で触れるコーナーは数十〜数百件程度の真の疎データであり、
  Int8Arrayだとチャンクの隅を1つ編集しただけでも4096要素ぶんの配列確保とシリアライズ時の
  全要素走査(非ゼロ探索)が必要になる。per-chunk Mapなら編集件数だけを保持・列挙でき、
  読み書き双方でO(編集件数)を維持できる
- `createEditedTerrainField(base, diffs?)` はbaseとdiffsを合成したTerrainFieldを返す。
  `cornerHeightAt`はオーバーライド→基底の順。`cellCornerHeights`/`cellHeightAt`/
  `terrainTypeAt`はすべて合成後のコーナーから導出するため、盛土でmountain化・切土で
  grass復帰の両方が自然に成立する。ただしwaterだけは例外で、`terrainTypeAt`は常に
  `base.terrainTypeAt`がwaterかどうかを先に見る(waterはベースノイズ由来のプロパティで
  編集では作らない、という設計)。applyCornerEdit側のブロック規則が水セルに触れる編集を
  必ずno-opにするため、この「waterは基底に委ねる」判断とセルの整合は常に保たれる
- `applyCornerEdit(base, editedField, rect, mode, blockers)` はterrainEdit.tsのセル版
  ±1・BFS伝播アルゴリズムをコーナー格子へ移植したもの。rectで指定するのは従来通り
  CELLだが、実際に±1するのはその矩形が持つ全コーナー(セル数+1四方ぶん)。伝播も
  コーナー格子上の4近傍BFSで行う
  - `blockers: { isCellBlocked(x,z): boolean }` という1つの述語にrail/station/depot/
    signal・町タイル・水域・範囲外の4条件をすべて集約させた。これによりterrainOverlay.ts
    自体はrailMap/townTiles/CellDataの型を一切知らずに済み、P3で消費側に配線するときは
    呼び出し側がゲーム状態から述語を組み立てるだけでよい
  - 変化したコーナーを4隅のどれかに持つセル(TOUCHING_CELL_OFFSETSの4通り)のいずれかが
    isCellBlockedを満たしたら、その時点で編集全体を同一参照no-opにして打ち切る
  - 確定時、コーナーの新しい値が`base.cornerHeightAt`と一致する場合はdiffsのエントリを
    削除する(基底へ戻ったコーナーのオーバーライドを残さない=疎性維持)。このため
    `base`(元のTerrainField)を`editedField`とは別引数で渡す設計にしてある
- シリアライズは`[chunkKey, [ [localIndex, height], ... ]][]`という素朴なタプル配列。
  SaveData v15への組み込みはP3以降
- ハマりどころ: プロパティテスト用に平坦(標高0一定)のダミーTerrainFieldを用意し、
  実ノイズ地形(createTerrainField)は「湖の隣で盛土→水域が崩れない」テストにのみ使った。
  ノイズ地形で汎用のランダム編集プロパティテストをやると、基底そのものの起伏が
  BFS伝播の停止条件に混ざり判定が複雑になるため、ロジック検証は平坦fieldで、
  water境界の実地形固有の検証だけ本物のfieldで行う、と役割を分けた

## P4実装メモ(TerrainBlocks/Sceneryのチャンク描画化)

- **チャンクサイズ**: 32×32セル(`render/terrainChunks.ts`の`TERRAIN_CHUNK_SIZE`)。
  既定マップ(halfExtent=45、91×91セル)は4×4=16チャンクにまたがる。
- **純粋なチャンク座標計算(`render/terrainChunks.ts`)**: `visibleChunkRange
  (cameraTargetCell, viewRadiusCells, halfExtent, margin)`が可視範囲(注視点±半径)を
  チャンク座標へ変換し、mapChunkBounds(halfExtentから導く)へクランプしてから
  margin(既定1)ぶん外側へ広げる。境界クランプは「範囲同士のintersect」ではなく
  「各端点を独立にクランプ」で実装した: 注視点がマップ外はるか遠くを向いていても
  空配列にならず、必ずマップの縁のチャンクへ収束するようにするため(intersect方式だと
  クランプ後にcx0>cx1の逆転が起きて空になるケースがあった)。`chunkCells(chunk,
  halfExtent)`はチャンク内の全セルをマップ範囲でクランプしつつx昇順→z昇順で列挙する
  (TerrainBlocks/Sceneryの旧・全域スキャンと同じ走査順を保つ)。Vitestで境界クランプ・
  margin・縮退マップ(halfExtent=0/負)・マップサイズ非依存性(halfExtent=45と8192で
  可視チャンク数が同じ)を検証した。
- **キャッシュ無効化キー(`sim/terrainOverlay.ts`の`overlayChunkRefs`)**: P2の
  `applyCornerEdit`は編集で触れたオーバーレイチャンク(OVERLAY_CHUNK_SIZE=64単位)
  だけを新しいMapへ差し替える(immutable replace)という既存の設計を利用した。
  `overlayChunkRefs(diffs, cellBounds)`は指定セル範囲の4隅コーナーに重なりうる
  オーバーレイチャンクのサブMap(参照)を集めて返す。TerrainBlocksはチャンクごとに
  この参照配列を保持し、次回描画時に同じ参照配列(浅い比較)なら地形編集の影響を
  受けていないと判定してジオメトリを再利用する。deep equalやdiffs全体の走査は
  不要で、判定コストは「そのチャンクに重なるオーバーレイチャンク数」のみに依存する。
- **TerrainBlocksの構成**: 全域を1回スキャンしてマテリアル別にマージしていた処理を
  `buildChunkGeometry(field, cellBounds)`という関数へ切り出し、チャンクごとに呼ぶ
  ように変更した。`useRef<Map<chunkKey, ChunkCacheEntry>>`でチャンクキャッシュを
  保持し、可視チャンク一覧(`visibleChunkRange`)を毎回の描画(chunkView変化時)で
  なめて、キャッシュヒット/ミスに応じて再利用または`buildChunkGeometry`→
  `dispose()`(旧ジオメトリ)を行う。可視範囲(マージン込み)からさらに1チャンク以上
  離れたエントリはLRU的に間引く(`CHUNK_CACHE_LIMIT=256`超過時のみ)。
- **カメラ可視範囲の取得(`GameScene.tsx`の`CameraChunkTracker`)**: 直交カメラの
  NDC4隅(±1,±1)を`unproject`でワールド空間の近平面・遠平面点へ変換し、
  y=0平面との交点を求めて外接矩形を計算する(design memoで指定された方式)。
  毎フレームではなく、OrbitControlsの`'change'`イベント(パン・ズーム)を起点に
  150msスロットルで更新する(`setTimeout`ベース、既に予約済みなら追加予約しない)。
  戻り値は`{targetCell, viewRadiusCells}`で、TerrainBlocksとScenery両方に同じ値を渡す。
- **Sceneryのチャンク化**: 木の候補列挙を`-range..range`の全域ループから、
  TerrainBlocksと同じ`visibleChunkRange`→`chunkCells`の列挙に変更した。配置自体は
  既存通りセル座標のハッシュ(`hash01`)のみで決まる純粋な関数なので、可視チャンクの
  組み合わせが変わっても同じセルには常に同じ木が生える(チャンク非依存の決定性は
  自動的に満たされる。設計変更は不要だった)。
- **地面プレーン・ポインタ判定**: 既定マップ(halfExtent<=約140相当)では、以前と
  同じく原点固定・一定サイズ(最低140、`2*halfExtent+40`)のプレーンでマップ全域を
  覆う。halfExtentがそれを超える大きいマップでは、プレーンをカメラ注視チャンクへ
  追従させる(`GROUND_PLANE_SPAN=320`固定サイズ、位置は注視セルを32セル単位へ
  スナップ)。スナップにより、chunkViewが数セル動くだけでは再配置が起きず、
  ポインタ判定用ジオメトリの位置更新頻度を抑えている。gridHelperも同じ中心・
  サイズに追従させた。
- **配線**: `useGameLogic`の戻り値に`cornerDiffs`を追加し、`App.tsx`→
  `GameScene`(`cornerDiffs`prop)→`TerrainBlocks`(`diffs`prop)と橋渡しした。
  `field`propは引き続き合成済み(baseField+cornerDiffs)のTerrainFieldを渡すが、
  チャンクキャッシュの無効化判定には`diffs`(cornerDiffs)を別途渡す必要がある
  (TerrainFieldインターフェース自体はdiffsを公開しないデバッグシナリオ用の
  fieldもありうるため、propとして明示的に分離した)。
- **デバッグ用の可視化**: 既存の`window.__debugWorld`/`window.__dbgStep`と同じ
  慣行で`window.__terrainChunkStats = {visible, cached, rebuiltThisPass}`を
  TerrainBlocksから公開した(消さずに残す。今後のチャンク関連デバッグに使う)。
- **ブラウザ検証**: 既定マップ(halfExtent=45)で起動直後、`__terrainChunkStats`が
  `{visible:16, cached:16, rebuiltThisPass:0}`(マップ全体が4×4チャンクに収まる)を
  示すことを確認し、地形・町・木の見た目が変更前と同一であることをスクリーンショットで
  確認した。コンソールエラーは無し。halfExtent=512相当の大規模スケール実測・
  盛土/切土によるチャンク単位再構築のブラウザ上での直接確認(rebuiltThisPassの
  増減)は本セッションの時間内には完了できておらず、今後の課題として残る
  (無効化ロジック自体は`sim/terrainOverlay.test.ts`の`overlayChunkRefs`テストで
  「無関係な遠方チャンクへの参照は変化しない」「編集チャンクの参照はimmutable
  replaceで確実に変わる」をVitestで担保済み)。

## P3実装メモ(消費側のfield移行・SaveData v15)

- **状態形状(useGameLogic.ts)**: `heights`/`terrain` Mapを廃止し、`worldSeed`
  (setter付き)・`halfExtent`(当面`TERRAIN_COORD_RANGE=45`固定・setterなし)・
  `cornerDiffs`(CornerDiffs、setter付き)の3つをReact stateにした。
  `baseField = useMemo(createTerrainField(worldSeed, halfExtent))` →
  `editedField = useMemo(createEditedTerrainField(baseField, cornerDiffs))` の2段
  useMemoで合成し、`field = debugFieldOverride ?? editedField` を実際にゲーム全体が
  参照するfieldとして公開する(`field`/`baseField`/`editedField`/`halfExtent`を
  フックの戻り値に追加)。`SimWorld.terrain`/`heights`は`terrainField?: TerrainField`
  1本に置き換えた。
- **デバッグシナリオの上書き(debugFieldOverride)**: 手組みの尾根地形(山岳トンネル
  シナリオ)のような「seedでは表現できない形」のために、`debugFieldOverride:
  TerrainField | null` という専用stateを追加した(設計で明示されていなかった追加
  判断)。`DebugScenarioWorld`は`field?: TerrainField`(fieldFromMapsで橋渡し)か
  `worldSeedOverride?: number`(通常の乱数地形に差し替えたい場合。地形編集の遊び場
  シナリオがこちら)のどちらかを持つ。`debugFieldOverride`が立っている間は
  地形編集(盛土/切土)を無効化した(no-op)。デバッグ専用の割り切りとして許容。
- **地形編集(terrainEdit→terrainOverlay)**: `useGameLogic.commitPath`の
  raise/lower分岐を`terrainEdit.applyTerrainEdit`から`terrainOverlay.applyCornerEdit`
  へ置き換えた。blockers述語(`isCellBlocked`)はrailMap.has/townTileIndex.has/
  `baseField.terrainTypeAt===='water'`/範囲外の4条件を1箇所に集約し、
  `buildPreview.evaluateBuild`のプレビュー側にも同じ組み立て方をコピーしている
  (UI側のGameUI.tsxとuseGameLogic.tsxの両方に同じblockers構築コードが存在する。
  P6以降で共通ヘルパーへ切り出す余地あり)。旧terrainEdit.tsはツリーに残るが
  どこからも呼ばれない。
- **消費側の移行**: construction/buildPreview/towns/townTiles/tunnel/economy/
  simulation(resolveTownSpawnTick)を`terrain: Map`+`heights: Map`の2引数から
  `field: TerrainField`の1引数へ統一した。construction.tsの
  `pathHasUnsupportedMountainCell`は`cellCornerElevations`(内部でセルごとに
  `buildCornerElevationMap`を全域構築するO(N)関数)を`field.cellCornerHeights(x,z)`
  (O(1))に置き換え、path長に対する隠れO(N²)を解消した。
- **tunnel.tsの簡略化(設計外の追加判断)**: `TerrainField.cellHeightAt`は常に
  4隅コーナーのmin(terrainField.ts/terrainOverlay.tsの一次データ設計そのもの)
  として定義されるため、旧`tunnel.ts`の「コーナー判定が薄すぎて失敗したら
  セル自身の生標高でフォールバックする」ロジックは、field化後は
  `field.cellHeightAt(x,z)>=level` ⟺ `cellCornerHeights(x,z).every(h=>h>=level)`
  という数学的な恒等式になり、独立したフォールバックとして機能しなくなった
  (旧terrain.tsはelevation Mapとcorner Mapが別々の実体だったため食い違い得たが、
  fieldに一本化した時点でその食い違いの余地自体が消えた)。フォールバック分岐を
  削除し、孤立/線状(幅1セル)の薄い山は「まだ実体の無い山」として通常の露出した
  高架(坑口も内部非表示も無し)のまま扱うよう統一した。これは1-Lipschitzな
  地形では本来ありえない入力(孤立した高低差1の1セルは、周囲が標高0なら
  Lipschitz制約に違反する)に対する挙動なので、実際の生成地形には影響しない。
  `tunnelPortals`の行き止まり坑口判定も`elevationAt<=0`から
  `field.terrainTypeAt(...)!=='mountain'`に変更した(コーナー崩れの影響を受けない
  型ベースの判定にした)。
- **SaveData v15**: `{ version: 15, seed, halfExtent, cornerDiffs: SerialisedCornerDiffs,
  ...v14の非地形フィールド全部 }`。`terrain`/`heights`配列は廃止。
  `deserialiseWorld`は`data.version !== 15`なら即座に`null`を返す(v1〜v14の移行
  チェーンは全削除)。呼び出し側(`useGameLogic.loadGame`)は`null`ならセーブ無視
  (console.warnのみ)にした。`RestoredWorld`も`terrain`/`heights`を`seed`/
  `halfExtent`/`cornerDiffs`に置き換えた。
- **描画(interim)**: `TerrainBlocks`/`Scenery`は`Map`走査から`-halfExtent..halfExtent`
  の二重ループ+`field`クエリへ変更(P4のチャンク化まではこのまま)。
  `GameScene`のトンネル坑口計算は`buildCornerElevationMap`の代わりに`field`を
  直接`buildElevatedTunnelIndex`/`tunnelPortals`へ渡すだけになった。
- **意外だった点**: `TerrainField.cellHeightAt`をコーナーmin-ruleで一本化した
  結果、tunnel.tsの「フォールバック」が数学的に無意味化するという副作用が
  P3着手時点では読めていなかった(P1/P2の設計時にはtunnel.ts側の消費コードまで
  検証していなかったため)。fieldインターフェースを1つに統一する設計の代償として、
  「コーナー由来の値」と「セル固有の生の値」という2つの独立したデータ源に依存する
  旧ロジックは、そのままでは移植できず簡略化(または削除)が必要になる、という
  一般的な教訓が得られた。
