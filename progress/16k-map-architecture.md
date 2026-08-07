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
  openttd-slope-notes.md(調査中)を参照して別途設計する

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

- `createTerrainField(seed, halfExtent)` が `heightAt`/`terrainTypeAt` を返す。terrain.tsの
  `generateHeights`と同じ「フラクタル値ノイズ(smoothstep双線形補間)+平地バイアス+HEIGHT_GAIN」
  構成だが、normaliseHeights(全域2パス距離変換)を使わず、オクターブの振幅/波長そのものから
  1-Lipschitzを導く: smoothstepの最大傾き1.5と各オクターブの波長から連続場の勾配上界を計算し
  (`Σ (amp_i/AMPLITUDE_SUM) * 1.5/wave_i`)、HEIGHT_GAINをその逆数未満に選ぶことで、
  丸め後も隣接差1以下になることを保証する(「1-Lipschitzな連続関数を最近接整数に丸めても
  隣接差は1以下」という事実に依拠。詳細な式はterrainField.ts内のコメント参照)
- オクターブのシードはrngの逐次状態ではなく `deriveOctaveSeed(seed, index)`(murmur3風
  finalizer)で純粋に導出する。これによりheightAtがどのセルからでも同じ結果を出せる
  (チャンク非依存性の要件)
- 水域は同一の合成ノイズ場を2つの閾値(WATER_THRESHOLD < FLATLAND_THRESHOLD)で切るだけ。
  別ノイズ場を使わないため、湖の縁が平地フロアの内側に必然的に収まり、1-Lipschitzの証明が
  水域を含めてそのまま成立する
- 範囲外(|x|または|z| > halfExtent)は常に 'grass'/標高0(境界との連続性は保証しない、
  という設計判断。コメントに明記)
- テストは決定性・値域・水域/山岳の整合・範囲外・1-Lipschitz(遠方x≈8000やチャンク境界
  64の倍数を含む散らばった64×64窓)・平地優勢の分布・性能ガード(50ms)をカバー
- terrain.ts/hooks/componentsへの配線はまだ行っていない(このフェーズはadditiveのみ)
