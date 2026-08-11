# TERRAIN_COORD_RANGE 拡大時の生成・描画・シミュレーション性能

## 目的 / 仮説

「世界が狭すぎる」対応で TERRAIN_COORD_RANGE(現行45 = 91×91セル)を大幅拡大したい。
仮説: sim層の生成は O(セル数) で軽いが、描画(TerrainBlocks等のジオメトリ量・ドローコール)が
ボトルネックになり、大きなマップでは JS/TS のままでは重く、Rust/Go エンジン自作が必要になる。

## 環境

- ホスト: Mac (Darwin 25.5.0)、ブラウザ = Claude Code 内蔵 Browser ペイン(Chromium)
- リポジトリ: CubicTransim v0.3.0-Alpha-35b(branch feature/stopping-and-diorama-visuals, 48a862a)
- Node ベンチ: vitest 4.1.10(`tools/genBench.test.ts` を src/sim/ へ一時コピーして実行)
- ブラウザ計測: dev サーバ(port 5175)。非表示タブでは rAF が止まるため、
  `window.__dbgThree`(SimulationDriver に追加した計測フック)経由で `gl.render(scene, camera)` を
  同期30回実行し中央値を取得。**CPU submit 時間のみで GPU 時間は含まない**点に注意

## 手順

1. `npx vitest run src/sim/__genBench.test.ts --silent=false --disable-console-intercept`
   (map_scale_research/tools/genBench.test.ts をコピー・import書換えして実行)
2. ブラウザ: TERRAIN_COORD_RANGE を 45→128→256 に一時変更し、通常開始→ `gl.render` 30回計測 +
   `__dbgStep(0.1, 100)` の所要時間。最後の条件では TOWN_COORD_RANGE 40→240・町数 8→64 も拡大
3. 計測後、定数はすべて元に戻した(__dbgThree フックのみ残置)

## 結果

### 標高生成パイプライン(Node, 中央値, 5回)

| range | セル数 | generateHeights | normaliseHeights |
|---|---|---|---|
| 45 (現行) | 91²=8,281 | 1.1ms | 1.8ms |
| 128 | 257²=66,049 | 7.8ms | 9.0ms |
| 181 | 363²=131,769 | 16.9ms | 18.3ms |
| 256 | 513²=263,169 | 38.7ms | 39.6ms |

きれいな O(セル数)。513×513 でも合計 ~80ms(起動時1回きり)。

### ブラウザ実測(gl.render CPU中央値 / renderer.info)

| 条件 | ドローコール | 三角形 | render CPU | __dbgStep 100tick |
|---|---|---|---|---|
| range45・町8 (基準) | 14 | 38,830 | 0.2ms | — |
| range128・町8 | 15 | 80,652 | 0.2ms | — |
| range256・町8 | 15 | 240,458 | 0.5ms | 0.6ms |
| range256・町64(範囲240) | 15 | 389,080 | 0.4ms | 0.5ms |

ジオメトリはマテリアル別にマージ済みのため、面積32倍・町8倍でもドローコールは 14→15 のまま。
起動・シナリオ開始・地形/町の描画はいずれも体感で問題なし(スクリーンショット確認済み)。

## 結論

**仮説は棄却済み**。513×513(現行の32倍面積)+ 町64個でも、生成 ~80ms(1回)、
ドローコール15、三角形39万、render CPU 0.5ms 未満、stepWorld 5µs/tick で、
現行アーキテクチャ(TS + three.js のジオメトリマージ)のまま余裕がある。
**Rust/Go エンジン自作はこの規模では不要**。39万三角形・15コールは GPU 側も
現代の統合GPUで余裕の範囲(GPU 時間は未計測だが桁が違う)。

## 追記: TTD級(2048²〜8192²)への外挿実測

ユーザーの常用サイズは OpenTTD の 2048×2048〜8192×8192。この規模を追加実測した。

### 生成時間(Node, 中央値, 3回)

| range | セル数 | generateHeights | normaliseHeights |
|---|---|---|---|
| 512 | 1025²=105万 | 251ms | 256ms |
| 1024 | 2049²=420万 | 1114ms | 1269ms |

O(セル数) のまま。2048² で合計 ~2.4s(起動時1回)。8192² は外挿で ~40s — 要ワーカー化/プログレス表示だが原理的問題はない。

### メモリ(Node 実測)

| データ構造 | 2049² | 8193²(外挿/実測) |
|---|---|---|
| 現行 `Map<string, number>`(文字列キー) | **442 MB** | ~7 GB(破綻) |
| `Int8Array` フラット格子 | 4 MB | **64 MB**(実測) |

### 結論(TTD級)

- **ボトルネックは言語ではなくデータ構造とレンダリング方式**。
  - sim: 文字列キー Map → 型付き配列(Int8Array 等)+数値インデックスへの移行が必須。これは TS のままで解決する
  - 描画: 現行の「全セルを1ジオメトリにマージ」は 2048² で数千万三角形・ビルド数分・GB級になり破綻。
    **チャンク方式**(例: 64×64セル単位でジオメトリを構築し、アイソメカメラの可視範囲±マージンのみ生成・破棄)にすれば
    描画コストはマップサイズ非依存(可視セル数のみ)になる。OpenTTD 自体もビューポート内だけ描く方式
  - stepWorld は列車数・町数依存でセル数非依存のため、TTD級でも現行のまま影響なし
- **Rust/Go エンジン自作は依然として不要**(仮説棄却を維持)。ネイティブ化しても
  「全セルマージ」の描画方式のままでは同様に破綻し、チャンク化すれば TS+three.js で足りる。
  WASM 化が意味を持つのはセル数比例の毎tick処理を将来導入した場合のみ

## 次の一手 / 未検証事項

- **GPU フレーム時間の実測**(表示状態のタブでの FPS)。非表示タブ制約で未計測。CPU側指標からは問題の兆候なし
- **建設・町成長時のジオメトリ再マージのヒッチ**。useMemo の全再構築が O(コンテンツ量) なので、
  巨大マップで線路網・町が育ちきった終盤に1回の建設で何ms止まるかは未測定(差分マージ化の余地)
- **列車数十編成時の stepWorld / DynamicTrain 描画**(今回は列車0編成)
- 実採用時は湖の数・町の数・TOWN_COORD_RANGE を面積比例でスケールさせること
  (今回は towns=64・範囲240 をハードコードで仮置き)
- 旅客の重力モデル・経路探索は駅数依存(マップ面積そのものには非依存)なので今回未測定

## 追記2: 16K実プレイの「重さ」の原因(v0.3.0-Alpha-40c)

実測(ブラウザ、極大16385マップ、町5523):
- 定常: gl.render 0.7ms / 9コール / 3.2万tris、stepWorld 10秒ぶん0.3ms — 問題なし
- 遠方ジャンプ(25チャンク新規構築): 389ms のヒッチ(150msスロットル込み)
- 内訳: **field問い合わせがチャンクあたり5.4ms**(32²セル×4隅×4オクターブのノイズを
  セルごとに独立計算。コーナーは隣接セルと共有されるのに4回ずつ再計算している)
- 町フィルタ(5523町)は0.6msで無害
- 小マップが軽い理由: 全16チャンクが起動直後にキャッシュされ、パンしても新規構築が
  発生しない。16Kは常に新チャンク構築が走る

対策方針(P9として実施):
1. チャンク構築時に33×33のコーナー格子を1回だけ評価して共有(4x削減)
2. さらにオクターブ格子値のチャンク内キャッシュで数倍
3. チャンク構築を1フレームN枚に制限する漸進キュー(ヒッチ→なだらかなポップイン)
4. ズームアウト拡張はLOD(遠景モード: 粗サンプリング地形+町ドット、木・家省略)が前提

## 追記2の対策結果(P9a、v0.3.0-Alpha-41a)

上記「追記2」の診断(セルごとに4隅を独立再計算・水域判定も4隅×独立再計算)に対して、
`src/sim/terrainField.ts` に `TerrainField.cornerGridFor(x0,z0,w,h)` /
`waterCornerGridFor(x0,z0,w,h)`(いずれも任意実装、`TerrainField`インターフェースの
オプショナルメンバ)を追加した。

### 設計

- `cornerGridFor`は (w+1)×(h+1) のコーナー格子を **1回のオクターブ格子キャッシュ**で
  まとめて評価する: オクターブごとに窓が実際に参照する格子点(gx,gz)の集合(1オクターブ
  あたり `window/wave + 2` 個程度)だけを先にハッシュ化してキャッシュし、各頂点は
  そのキャッシュへの配列引き+双線形補間だけで済ませる(`hashLattice`をコーナーごとに
  4回×4オクターブ呼ぶ経路を廃止)。`waterCornerGridFor`も同じオクターブキャッシュの
  合成ノイズ値から閾値判定するだけで、追加のノイズ計算はしない。
- `createEditedTerrainField`(terrainOverlay.ts)の`cornerGridFor`は
  base.cornerGridForで下地格子を作ってから、overlayChunkRefsと同じ考え方で
  「窓に重なるオーバーレイチャンクだけ」を走査して疎な上書きを重ねる合成にした。
  waterはbaseの`waterCornerGridFor`にそのまま委譲する(編集は水域を作らない前提と一致)。
- `cornerGridFor`/`waterCornerGridFor`はfieldインターフェース上は任意実装のため、
  未実装のfield(テストのリテラルフィクスチャ、fieldFromMaps等)に対しては
  モジュール関数`cornerGridFor(field,...)`/`waterCornerGridFor(field,...)`が
  cornerHeightAt/terrainTypeAtへの逐次フォールバックを提供し、後方互換を保つ。
- `TerrainBlocks.buildChunkGeometry`と`Scenery`の候補列挙は、チャンク/可視チャンクごとに
  この2つのバッチAPIを1回ずつ呼び、以降はセルごとに配列引き(`cellCornersFromGrid`)
  だけで4隅・水域判定を済ませるように書き換えた(`field.cellCornerHeights`/
  `field.terrainTypeAt`の個別呼び出しを除去)。TownBlocksは町サブタイル単位の
  参照(全セルスキャンではない)であり診断対象の全セルコーナー再計算パターンに
  該当しないため対象外とした。

### プロパティテスト・性能テスト(Vitest)

- `src/sim/terrainField.test.ts`: `cornerGridFor`/`waterCornerGridFor`が乱数窓・境界窓で
  `cornerHeightAt`/`terrainTypeAt`由来の定義と厳密一致することを検証。33×33格子の
  性能ガード(9サンプルの中央値<1ms)も追加。
- `src/sim/terrainOverlay.test.ts`: `createEditedTerrainField`の`cornerGridFor`が
  複数箇所の盛土後も乱数窓で`cornerHeightAt`と厳密一致すること、編集コーナーを
  跨ぐ窓でも一致すること、`waterCornerGridFor`がbaseへ委譲されることを検証。
- `src/render/terrainChunks.test.ts`: 漸進ビルドキューの優先順位づけ(純粋関数
  `selectChunksToBuild`)を上限件数・近接優先・非破壊性の観点でテスト。
- 全757→762件、`npm run test`/`npm run build`green。

### 実測(ブラウザ、極大16385マップ、port 5175)

`window.__debugWorld.terrainField`を直接使い、追記2と同じ「フィールド問い合わせだけ」の
コストを1チャンク(32×32セル)ぶんで比較した(10サンプルの中央値、JITウォームアップ後):

| 方式 | 中央値 |
|---|---|
| 旧方式相当(セルごとに`cellCornerHeights`+`terrainTypeAt`を個別呼び出し) | 1.6ms |
| 新方式(`cornerGridFor`+`waterCornerGridFor`を1回ずつ) | 0.1ms |

**約16倍高速化**(追記2の診断値5.4ms/チャンクとは環境・シードが異なるため直接比較は
できないが、同じ「4隅の重複再計算」を解消したことによる同種の改善であることを確認)。

### 漸進ビルドキュー(TerrainBlocks)

- `MAX_CHUNK_BUILDS_PER_PASS = 3`。`chunkEntries`のuseMemoを「キャッシュヒットの採用」
  「ミスの収集→`selectChunksToBuild`で近接優先ソート+上限適用」「上限内だけ新規構築」の
  3段に分け、積み残し(`pendingThisPass`)が残っていれば`requestAnimationFrame`で
  `buildTick`を進めて次フレームで続きを処理する。
- ブラウザでの`__terrainChunkStats`(`visible/cached/rebuiltThisPass/pendingThisPass`)を
  使って、通常のチャンク再利用(`cached`が変わらず`rebuiltThisPass:0`)・新規構築
  (`rebuiltThisPass`>0)の両方の遷移を確認した。
- **未検証事項(正直な申告)**: Browserペインの非表示タブ制約(CLAUDE.md記載どおり)により
  `requestAnimationFrame`が止まるため、実際のパン操作中のフレーム時間(rAF/PerformanceObserver
  longtask)を本セッションでは計測できなかった。`window.__orbitControls`のtarget/positionを
  スクリプトで直接書き換える方法も試したが、OrbitControls内部の球面座標キャッシュと
  手動書き換えが噛み合わず、縮退した(視界チャンク数1の)ビューになってしまい、
  ジャンプ後の`pendingThisPass`推移を安定して観測できなかった。上記の「フィールド問い合わせ
  16倍高速化」は診断されたボトルネックそのものへの直接的な実測であり、キューの優先順位
  ロジック自体は`selectChunksToBuild`の単体テストで担保しているが、**「1フレーム16ms超の
  ヒッチが無くなったか」のエンドツーエンドのフレーム時間実測は今回できていない**。
  可視タブでの実機確認(ユーザー操作 or Playwright等の可視ブラウザでのlongtask計測)を
  今後の宿題として残す。
