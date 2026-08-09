# 地形プロファイル(平坦 / 標準 / 山がち)

新規ゲームで「地形の起伏」を選べるようにした(要望: 「もうちょっと山がちな地形を選べたら
楽しいかも」)。0.5.0-Alpha-4a。

## Decision

**変えるのは「合成ノイズ分子Nを標高へ落とすしきい値テーブル」だけ**にした。ハッシュ・
オクターブ((40,8),(20,4),(10,2),(5,1))・N=8q0+4q1+2q2+q3 の計算、水域しきい値
(N < 9*2^30)はプロファイル間で完全に共通で、1バイトも変えていない。

この設計により:

- 正準定義(`progress/canonical-terrain-noise-integer.md`)の1000件テストベクタと、
  TS/Rust/WGSLのバイト一致検証機構がそのまま生き続ける(標準=normalは歴史的既定と完全一致)。
- 同じseedなら3プロファイルの地形は「同じ地形の等高線を別のしきい値で切った」関係になる
  (尾根・谷・湖・町の位置が対応する)。実際にブラウザで同一seedの3枚を並べて確認した。
- WGSL側にプロファイル分岐が要らない(CPUで解決したu64しきい値10件をparams uniformで渡す)。

### しきい値テーブル(正準の分母 FULL = 15 * 2^32 = 64,424,509,440)

| 標高 | flat(平坦) | normal(標準・歴史的既定) | mountain(山がち) |
|---|---|---|---|
| 1 | 43,486,543,872 | 35,433,480,192 | 28,991,029,248 |
| 2 | 51,286,543,872 | 41,290,253,778 | 34,191,029,248 |
| 3 | 59,086,543,872 | 47,147,027,363 | 39,391,029,248 |
| 4 | 66,886,543,872 | 53,003,800,949 | 44,591,029,248 |
| 5 | 74,686,543,872 | 58,860,574,534 | 49,791,029,248 |
| 6 | 82,486,543,872 | 64,717,348,120 | 54,991,029,248 |
| 7 | 90,286,543,872 | 70,574,121,705 | 60,191,029,248 |
| 8 | 98,086,543,872 | 76,430,895,291 | 65,391,029,248 |
| 9 | 105,886,543,872 | 82,287,668,876 | 70,591,029,248 |
| 10 | 113,686,543,872 | 88,144,442,462 | 75,791,029,248 |

- flat: 標高1が 0.675*FULL、間隔 7,800,000,000(≒0.121)
- normal: 標高1が 0.55*FULL、間隔 5,856,773,585〜586(≒FULL/11)。**歴史的既定・不変**
- mountain: 標高1が 0.45*FULL、間隔 5,200,000,000(≒0.0807)

水域しきい値 9*2^30 = 9,663,676,416 は3プロファイル共通(=同じseedなら湖の位置と形も同じ)。

### 実測の効き方(seed 2026、halfExtent 128、セル単位の地形種別)

| プロファイル | grass(標高0が接する平地) | mountain(標高1以上) |
|---|---|---|
| flat | 96.9% | 3.1% |
| normal | 75.4% | 24.6% |
| mountain | 46.7% | 53.3% |

山がちでも平地が約47%残るので、駅・町・車庫を置く余地は十分にある(「起伏だらけだが
遊べる」を狙った値)。山がちのNの分布上、標高5〜7の高山も稀に出る。

## 1-Lipschitz(隣接コーナー標高差1以下)の構成保証

しきい値の間隔Sが「隣接コーナー間のNの差の上界B」以上であれば、隣接コーナーが2段以上
またぐには |ΔN| > S が必要になり矛盾する。つまり **S >= B** が構成保証の条件。

Bの導出(`src/sim/canonicalNoise.ts` の `ADJACENT_NUMERATOR_BOUND` のコメントと同じ):

- 各オクターブiの値ノイズは、u32格子ハッシュ(値域 2^32-1)をsmoothstep(最大傾き
  1.5/wave_i)で補間した**連続かつ区分C1**の関数。よってx(またはz)方向に1進んだときの
  変化は高々 (2^32-1) * 1.5/wave_i。
- N = Σ weight_i * q_i なので
  |ΔN| <= (2^32-1) * 1.5 * (8/40 + 4/20 + 2/10 + 1/5) = (2^32-1) * 1.2 < 1.2 * 2^32
  = **5,153,960,755.2**
- 整数化の丸め(lerpQの切り捨てが1オクターブ3回・重み合計15、smoothQのtのround_half_up)
  を足しても高々64しか増えないため、**B = 5,153,960,820** を保守的な整数上界として採用。

各プロファイルの最小間隔:

| プロファイル | 最小間隔 | B に対する余裕 |
|---|---|---|
| flat | 7,800,000,000 | +51.3% |
| normal | 5,856,773,585 | +13.6% |
| mountain | 5,200,000,000 | +0.9% |

山がちは上界ぎりぎりまで詰めてある(これ以上詰めると段差2が発生しうる)。参考までに、
実測の隣接|ΔN|の最大は5seed×30万点で 2,709,590,502(= 0.63 * 2^32)であり、証明上の
上界(1.2 * 2^32)よりかなり小さい。**それでも証明済みの上界を守る**方針は変えない
(seed次第で理論値に近づきうるため)。

テスト:

- `src/sim/canonicalNoise.test.ts` — テーブルの単調増加・間隔 >= B・標高1しきい値 > 水域
  しきい値・normalが歴史的既定と一致・同じNに対し flat <= normal <= mountain
- `src/sim/terrainField.test.ts` — プロファイル省略時=normal、3プロファイルで
  100万ペア超の隣接コーナー差1以下、水セルの4隅が必ず標高0、バッチAPI一致
- `renderer/terrain_core/src/lib.rs` — 同じ不変条件のRust版(全プロファイル25万点ずつの
  隣接差テストを含む)

## 水域との関係

水域はNが 9*2^30 未満の頂点が4隅すべてに揃ったセル。全プロファイルで
「標高1のしきい値 > 水域しきい値」が成り立つため、**水域セルの4隅は必ず標高0**
(=湖が斜面や高台に載ることはない)。この不変条件はTS/Rust双方でテストしている。

## 配線

- TS: `createTerrainField(seed, halfExtent, profile = 'normal')`。しきい値テーブルは
  field生成時に1度だけ解決する(頂点ごとのRecord引きを避けるため)。型は
  `TerrainProfile = 'flat' | 'normal' | 'mountain'`。
- Rust: `quarterview_terrain_core::TerrainProfile`(`thresholds()` / `threshold_words()` /
  `from_name()` / `index()`)。`TerrainField::new` は従来どおりNormal、
  `TerrainField::with_profile` が新API。
- WGSL: `tile_generate.wgsl` / `terrain_noise.wgsl` の params uniform に
  `thresholds: array<vec4<u32>, 5>`(u64を(hi,lo)で10件=20語)を追加。**シェーダ側に
  プロファイル分岐は無い**。TileParamsは 32byte → 112byte になったので、params bufferを
  自前で組む場所(lib.rs / tile_check / edit_check / layer_b_bench / fullmap_render /
  offscreen_render / web/bench/browser-compute.mjs)はすべて20語を積む必要がある
  (層Bゲートがこの追随漏れを4件検出した)。
- レンダラーAPI: `CanvasRenderer.create(canvas, seed, halfExtent, profile?)`。プロファイルは
  世界ごとに不変なので生成時に固定し、変更時はレイヤーごと作り直す(App.tsxのkeyに含めた)。
  `cpuTilePacked` / `cpu_corner_height` / `profileThresholdWords` も検証用にプロファイル対応。
- セーブ: **v16**。`terrainProfile` を追加。v15セーブは「標準テーブルで生成された地形」で
  あることが確定しているので、**拒否せず 'normal' として読み込む**(v14以前のような
  破壊的な形式変更ではないため)。
- UI: 起動ダイアログの「町の密度」の下に「地形」(平坦/標準/山がち)を追加(theme.tsトークン)。

## Alternatives considered

- **オクターブ振幅・波長をプロファイルごとに変える**: 起伏の「質」まで変えられるが、
  正準定義(1000ベクタ・TS/Rust/WGSLのバイト一致)がプロファイルごとに別物になり、
  検証機構を3倍に増やす必要がある。棄却。
- **WGSLにプロファイル分岐(profile indexを渡して3テーブルを埋め込む)**: シェーダに
  同じ数値を二重管理することになり、TS/Rustとのドリフト源が増える。uniformで
  解決済みの値を渡す方式を採用。
- **v15セーブを拒否する**: 地形の互換性は壊れていない(terrainProfile欠落=normalで完全に
  再現できる)ので、拒否は利用者に不利益なだけ。受け入れる方を選択。

## Constraints / Gotchas

- **しきい値の間隔は絶対に B = 5,153,960,820 を下回らせないこと**。下回ると1-Lipschitz
  (=坂の生成・建設ロジック・OpenTTD流のスロープ規則すべての前提)が壊れる。
- TileParams(112byte)を自前で組む箇所を増やしたら、必ずしきい値20語も積むこと。
- 町の生成条件(`towns.ts`)は「水域が近くにない」「周辺の85%がflat」であり標高は問わない。
  山がちマップでも `MIN_STARTING_TOWNS`(3)は確保できることをテストで担保した
  (小マップ5seed)。極大(16385²)山がちマップでも町4,077個が270msで生成できている。

## ブラウザ実機での確認(Chrome / WebGPU / dev 5175)

- 同一seed(1681972299)の中マップ(257²)を3プロファイルで比較(セーブv16のterrainProfileを
  書き換えて読み込み直す方法で、seedを固定したまま切り替えた)。尾根・谷・町(青井村)の位置は
  3枚とも対応し、段丘の密度だけが変わる = 「同じノイズを別のしきい値で切った」関係を目視確認。
  山がち=段丘だらけ+広い平坦ポケット、標準=現行どおり、平坦=広大な平野に孤立した低い台地。
- 山がちマップの遊べること: 標高1→0→1→2→3を横断する17セルの線路を敷設(¥2,200)。坂セルが
  正しく生成され、崖の陰影(R4f)も段丘ごとに読める。尾根越えではトンネル計画が働き、
  出入口の標高が合わない経路は「トンネル出口の標高が合いません」で正しく拒否された。
- 山がちの極大マップ(16385²): 新規ゲーム生成(町4,077個を含む)が270ms、全図ズームアウトで
  drawCalls 9 / LOD5 / residentTiles 25 / tileGpuBytes 6.6MB。異常な遅さは無し。

## ゲート結果(0.5.0-Alpha-4a)

- `npm run test`: 944件 green / `npm run build`: green / `npm run build:renderer`: green /
  `cargo test --workspace --release --lib --bins`: green(terrain_core 11件)
- **層B(Mac / Apple M4 / Metal、3回計測)**: T1〜T7 strict すべて3回とも pass。
  T1 median 0.624/0.624/0.626ms・p99 1.447/1.304/1.086ms、T4 median 2.440/2.450/2.493ms・
  p99 3.291/3.241/3.949ms、T3/T5 hitch 0/10260、T6 firstFrame 11.1/7.4/6.1ms、
  T7 タイル遅延 median 0フレーム。anomalies なし。
- **層A(VM / llvmpipe / Vulkan、`--browser-exact --check-ts-migration`)**: build
  (workspaceTests/nativeBins/productionTsVsRust1M/wasmPack/vite)すべてtrue。判定対象の
  ゲートは全pass(`pass:null` は層B専用)。A1 median 0.000099ms/p99 0.000174ms、
  A2 0.000876ms/tile、A3 mismatch 0・CPU diff median 0.010255ms、A5/T10 heap 1,245,184B
  (上限96MiB)、A6/T15 wasm gzip 89,658B(上限1MiB)、A7 hitch 0、A8 決定性true、
  T4/T11 drawCalls 9(上限24)、T6 firstFrame 63.6ms、T14 5seed×1000万点 mismatch 0、
  cameraReplay 3回とも ok(score 68/78/57)。プロファイル関連の新ゲートは
  - `A4_production_ts_vs_rust_1m`: 本体TS `terrainField.ts` vs Rust を**プロファイルごとに
    100万点**(計300万点)バイト一致 → pass
  - `A4_tile_profiles_gpu_vs_cpu`: `tile_generate.wgsl` vs Rust CPU を**プロファイルごとに
    1,056,784点**(計3,170,352点)→ flat/normal/mountain すべて mismatch 0
  - `A4_noise_exact_profiles`: `terrain_noise.wgsl` vs Rust CPU を3プロファイル×200万点
    → すべて mismatch 0
  - `A4_noise_exact_browser_proto`(BrowserWebGPU読み戻し): 16タイル×66,049点=1,056,784点を
    3プロファイルを巡回させて検証 → mismatch 0
  - T14は従来の5seed×1000万点に加え、上記の全プロファイル一致も条件に含めた
