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

## P5実装メモ(町の16K対応・マップサイズ選択)

- **領域ベースの決定的町配置(`sim/towns.ts`)**: `TOWN_REGION_SIZE=128`のセル領域
  ごとに、(worldSeed, rx, rz)だけから町候補を最大1つ導出する`generateRegionTowns`
  を追加した。旧`generateTowns`(count個ループのグローバルrejection sampling)は
  テスト互換のため残したが、実プレイでの初期化(useGameLogicのtowns初期状態・
  newGame)は全て新しい方に切り替えた。
  - 存在ゲート`TOWN_REGION_DENSITY`(最終値0.4)→領域内ジッター位置→halfExtent範囲
    チェック→`isNearTerrain`(水域・山岳回避)の順に評価し、どれか1つでも落ちれば
    その領域に町は無い。
  - **密度の妥協**: 「91²マップに8個」と同じセルあたり密度には、領域サイズ128が
    91²マップ全体(halfExtent=45)より大きいため原理的に一致させられない(1領域=町0
    か1個)。既定マップ(小91×91)は町が2〜3個以下になることがある一方、16Kマップは
    実測4576町(狙い通り「a few thousand」のオーダー)になった。密度ゲートは
    ブラウザ確認で「中(257)マップが町0個で始まる」を見て0.3→0.4に調整した。
    小さいマップでの体感の薄さは`resolveTownSpawnTick`(輸送力に応じた町の湧き)が
    実プレイで補う設計とし、ここでは深追いしていない。
  - id体系は`town-r{rx},{rz}`。ランタイム湧き(`town-spawn-...`)と衝突しない
    (towns.test.tsで確認)。名前の一意性(`usedNames`)は領域間で共有しない設計に
    した(領域は他領域を参照できない=独立性の前提と両立しないため)。巨大マップでの
    同名重複は許容する。
  - 性能: `towns.test.ts`に16Kマップ相当(halfExtent=8192)で200ms未満のテストガード
    を追加。実測は数十ms程度。
- **町タイル索引の遅延キャッシュ(`sim/townTiles.ts`)**: `TownTileIndex`をMap具象型
  から`{has(key), get(key)}`のみのインターフェースへ緩めた。既存消費側
  (construction.ts/buildPreview.ts/GameUI.tsx/Scenery.tsx)はhas/getしか使わない
  ため無変更で動く。旧`buildTownIndexes`/`buildTownTileIndex`(全町eager生成、
  戻り値は具象`Map`=`EagerTownTileIndex`)は小規模な町集合向けに残しつつ、
  新設の`TownTileCache`クラスが町ごとの遅延生成・キャッシュを担う。
  - 空間索引: 町の中心を64セル四方のバケットへ割り当て、クエリセルの3×3バケット
    (町タイル半径の最大値16 < バケット半分32なので十分)だけを候補として舐める。
  - キャッシュキー: 町ごとに「最後に使ったrailMap参照」を覚え、参照が変わっていたら
    その町だけ再生成する。**簡略化した点**: 本来は「その町のbboxに触れる編集だけ」
    に絞り込むのが理想だが、railMapの差分セル一覧を呼び出し側が持っていないため、
    「参照が変わっていれば再生成」にした。ただし再生成は実際にクエリされた町だけに
    起きる(遠くの町は何度railMapが変わってもクエリされない限り再計算されない)ため、
    「railMap更新のたびに全町を舐める」という当初の問題は解消されている。
  - `get`/`has`はセルキー1つからtowns配列を舐めず、常に3×3バケットの候補だけを
    見るため、マップ全域のどのセルに対しても呼べる(カメラ位置に依存しない)。
- **TownBlocksのチャンク化(`components/GameScene.tsx`)**: `townSubTileIndex`という
  全町eagerなpropは廃止し、GameScene内で「可視チャンク範囲(chunkView)+1チャンク
  (32セル)先読み」に交差する町だけを`townIntersectsCellRange`で絞り込み、
  `TownTileCache.subTilesForTowns(visibleTownIds)`で可視町だけのサブタイルを
  都度合成してTownBlocksへ渡す。町の名前ラベル(Html)も同じ可視町リストだけを
  描画するため、遠方の町のHtmlオーバーレイが大量に積み上がることもない。
  TerrainBlocks/Sceneryが使っているP4のchunkView(CameraChunkTracker)をそのまま
  再利用しており、新しいカメラ追跡の仕組みは増やしていない。
- **マップサイズ選択UI(`App.tsx`)**: 起動ダイアログを「開始方法」から「マップサイズ
  選択(小91/中257/大1025/特大4097/極大16385)」に変更した。選択すると
  `useGameLogic.newGame(halfExtent)`を呼び、新しいworldSeed・指定halfExtentで
  地形・町・所持金など全状態を初期化する。`halfExtent`はuseGameLogicで
  `useState`(setter付き)にし、v15セーブに既にあった`halfExtent`フィールドへ
  そのまま乗せた(セーブ形式自体の変更は無い)。
- **カメラのパン範囲**: `OrbitControls`にtarget/distanceの制限を掛けていなかった
  ため(既存のminZoom/maxZoomはズームのみを制限)、そのままで16Kマップ全域へパン
  できる。追加の変更は不要だった。
- **ブラウザ確認**: 中(257)マップで起動→町が点在(1〜数個)することを確認。
  極大(16385)マップで起動→即座に描画(体感1秒未満、`__terrainChunkStats`は
  `{visible:16, cached:16}`のままでマップサイズに非依存)、`__debugWorld.towns.length`
  が4576であることを確認。保存→リロード→読込で、halfExtent(8192)・町4576件が
  そのまま復元されることを確認した。カメラを実際に大きくパンして遠方の町の
  タイル上に線路を敷いて踏切になることの目視確認は、座標系の都合(パン操作で
  数千セル移動するのは現実的なドラッグ量ではない)で本セッションでは行わず、
  代わりに`__debugWorld`から遠方町(x=-8123,z=-7963)の地形が`grass`であることの
  直接クエリと、`townTiles.test.ts`のTownTileCache単体テスト(railMap変化での
  再生成・マップ全域のどのセルでも呼べること)で代替検証した。今後の課題として
  残る。

## P5追記: 小マップの0町始まりバグ修正(0.3.0-Alpha-37b)

- **根本原因**: `regionTownCandidate`のジッターが領域全体(128×128)でサンプルされて
  いたため、マップの縁の領域(領域の大半がhalfExtent範囲外)ではジッター結果の
  大半が範囲外判定で棄却され、実効密度がTOWN_REGION_DENSITYよりずっと低く
  なっていた。既定マップ(halfExtent=45)は領域が4つしかなく、そのすべてが
  縁の領域(範囲との交差率はどれも約12%程度)だったため影響が特に大きく、
  200シード中175シードが町0個(平均0.14町)になっていた。
  - 修正: ジッターのサンプル範囲を「領域とマップ範囲の交差矩形」に変更した
    (`regionTownCandidate`)。これにより範囲外棄却は原理的に起きなくなり、
    実効密度がTOWN_REGION_DENSITYに近づく(テストで旧実装比5倍以上の
    候補生成率を確認)。
- **MIN_STARTING_TOWNS(=3)の保証**: 領域パス後の町数が3未満なら`fillMinimumTowns`
  が決定的な格子走査で追加する。ランダムrejection sampling(旧`generateTowns`と
  同型)は当初試したが、山岳・水域がマップの95%以上を占める外れ値seed(実測:
  平地セルが8281個中434個)では、有効な平地に一度も当たらないまま試行回数を
  使い切ることがあった。マップ全域を`FALLBACK_GRID_RESOLUTION`(=96)²の候補点で
  一様にカバーし、決定的ハッシュ順に試す格子走査へ変更し、条件を満たす場所が
  マップ上のどこかに存在する限りほぼ確実に見つけられるようにした。
  - フォールバック町同士の最低距離は`FALLBACK_TOWN_MIN_DISTANCE=6`(通常の
    `TOWN_MIN_DISTANCE=16`より緩い)。上記の外れ値seedでは、有効な平地が
    マップ隅の小さな1ブロックにしか存在せず、16マス間隔を要求すると3つ取れない
    ケースがあったため。タイル占有は先勝ち(TownTileCache)で処理されるため、
    多少近接しても致命的な破綻はない、という判断。
  - id体系は`town-fallback-{n}`。16Kマップでは領域パスだけでMIN_STARTING_TOWNSを
    大幅に超えるため、この経路はno-op(コストゼロ)。
- **結果**: 200シード(halfExtent=45)で0町なし・平均3.01町(min 3, max 4)。
  50シード(halfExtent=128)で0町なし・平均3.22町(min 3, max 5)。
  16Kマップの町数(実測4576前後)には変化なし。

## P6実装メモ(旧経路の削除、0.3.0-Alpha-38a)

- **削除したファイル**: `src/sim/terrainEdit.ts`(+`terrainEdit.test.ts`)。P3で
  `terrainOverlay.applyCornerEdit`に置き換わって以降、どこからもimportされていな
  かった(コメントでの言及のみ)。
- **削除したファイル**: `src/sim/terrain.ts`(+`terrain.test.ts`)。`generateMap`/
  `generateHeights`/`normaliseHeights`/`carveLake`はterrainField.tsの構成的
  1-Lipschitz地形に置き換わり未使用。`TERRAIN_HEIGHT_MAX`/`MOUNTAIN_HEIGHT_THRESHOLD`
  はP1時点で既にterrainField.tsに複製済みで完全に重複していた。`terrainAt`/
  `cornerElevation`/`buildCornerElevationMap`/`cellCornersFromMap`/
  `cellCornerElevations`も本番コードからの参照はゼロだった(コメントでの言及のみ)。
  - 唯一の例外は`computeElevation`/`elevationAt`: tunnel.test.ts/construction.test.ts
    が「境界からのマンハッタン距離で段丘状に標高が上がる山塊」のテストフィクスチャ
    作成に使っていたため、本番非依存のテスト専用ヘルパーとして
    `src/sim/testSupport/elevationFixture.ts`へそのまま移設した。
  - `TERRAIN_COORD_RANGE`(=45、既定マップの生成半径)は`terrainField.ts`の
    `DEFAULT_HALF_EXTENT`へ改名して移動し、useGameLogic.tsの初期halfExtentが
    これを参照するよう変更した。
- **towns.ts**: 実プレイでは`generateRegionTowns`に完全に置き換わって以降未使用
  だった`generateTowns`(count個ループのグローバルrejection sampling)と、それ
  専用の定数(`TOWN_COORD_RANGE`/`TOWN_MIN_DISTANCE`/`MAX_ATTEMPTS_PER_TOWN`)を
  削除した。towns.test.tsの該当カバレッジ(決定性・個数・命名重複なし等)は
  `generateRegionTowns`ベースのテストへ書き換えた。
- **重複していたblockers述語の統合**: P3実装メモに残っていた既知の課題
  (`useGameLogic.ts`のcommitPathと`GameUI.tsx`の建設プレビューが同じ4条件
  ―範囲外/rail・station・depot・signal/町タイル/水域―のisCellBlockedを別々に
  組み立てていた)を、`terrainOverlay.ts`の`buildEditBlockers({ halfExtent, railMap,
  townTileIndex, baseField })`という1つの関数へ集約し、両方から呼ぶように変更した。
- **persistence.tsのセーブ型チェーン簡略化**: v15のみを受け付ける
  `deserialiseWorld`は`data.version !== 15`のガード以外、v1〜v14の各フィールドを
  一切参照していなかった。`SaveDataV1`〜`SaveDataV14`(`LegacyCellData`/
  `LegacyLedger`含む、計13個の型定義)を削除し、バージョン判定専用の最小型
  `LegacySaveData`({version: number})1つに置き換えた。
  - ハマりどころ: TypeScriptの判別共用体は、判別子が`number`型(リテラルでない)の
    メンバーを持つと、他メンバーに対する`!== 15`のnarrowingでは除外されない
    (`LegacySaveData.version: number`は「15を含む可能性がある」と判定されるため)。
    `if (input.version !== 15) return null;`の直後で`const data = input as
    SaveDataV15;`と明示キャストすることで対処した。
- **確認**: `npm run test`(667件)・`npm run build`はいずれのコミットでも green。
  ブラウザ(port 5175)で既定マップの起動・地形描画・線路建設が変更前と同じ見た目で
  動作することを確認した。
