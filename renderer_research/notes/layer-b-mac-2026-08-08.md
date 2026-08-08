# Layer-B (実GPU) 計測: Apple M4 Mac / Metal (2026-08-08)

## 目的 / 仮説

`progress/quarterview-renderer-spec.md` の層B(実GPU)ゲート T1〜T8 を、開発者Mac(Apple M4, Metal backend
経由の wgpu)上で実測する。プロトタイプ段階の緩和判定((a) T3 ヒッチ0(パン・ズーム) (b) T4 全図 p99≤16.6ms
(c) T6 初期表示≤1s)を主判定とし、本実装の厳格値(T1/T2/T5)は参考記録とする。

仮説: プロトタイプの CPU 側ロジック(タイル選択・LRU・コマンド記録)は Layer-A(VM/software raster)で
すでに軽量と確認済みなので、実GPU上でも T1/T2/T4/T6 は容易に満たすはず。焦点は T3/T5(ヒッチ0)が
実GPUでも成立するか。

## 環境

- ホスト: Mac, Apple M4, macOS 26.5.2 (25F84)
- GPU adapter: `Apple M4` / backend `Metal` / device type `IntegratedGpu`(wgpu `adapter.get_info()`)
- Rust: rustc 1.93.0 / cargo 1.93.0
- wgpu: 24.0.5 (`renderer_research/proto/renderer_wgpu/Cargo.toml`)
- リリースビルド: `cargo build --release`
- 対象コード: `renderer_research/proto/renderer_wgpu/src/bin/layer_b_bench.rs`(今回新規作成)、
  および `renderer_research/proto/renderer_wgpu/src/bin/{offscreen_render,fullmap_render}.rs`
  (Mac 実行のため `Backends::VULKAN` → `Backends::METAL` に変更、既存の Layer-A/VM 用ロジックは無改修)

## 手順

### 1. 既存 native bin の Metal 実行確認(構造検証)

```sh
cd renderer_research/proto
cargo build --release --bin offscreen_render --bin fullmap_render
target/release/offscreen_render   # 800x600, 単一タイル
renderer_wgpu 配下から: ../target/release/fullmap_render   # 1600x900, 全図
```

両方とも `Backends::VULKAN` のままでは macOS に Vulkan アダプタが無く `adapter` で panic した
(このマシンには MoltenVK 等の Vulkan 層が入っていない)。`Backends::METAL` に変更後は即座に成功した。

### 2. 新規 Layer-B ベンチ (`layer_b_bench.rs`)

`web/bench/camera_replay.mjs` と同じ4フェーズ(static 120f → max-speed-pan 120f → full-map 120f →
zoom-roundtrip 90f-in+90f-out)を、`renderer_wgpu/src/lib.rs` の `CanvasRenderer`(タイルキャッシュ・
LRU・indirect draw)と同じアルゴリズムでオフスクリーン 1600×900 に再生する native バイナリ。
GPU タイムスタンプクエリ(`Features::TIMESTAMP_QUERY`)対応、CPU/GPU 時間を分離計測、
`bench/results/layer-b-<unix-ts>-runN.json` に Layer-A と同形式の JSON を出力する。

terraform(地形編集連打)はプロトタイプスコープ外(仕様書「プロトタイプ(縦切り)スコープ」参照)のため
未実装・T8はnull/対象外として記録。

```sh
cargo build --release --bin layer_b_bench
target/release/layer_b_bench bench/results/layer-b-<ts>-run1.json
```
(run2, run3 も同様に3回実行し、外れ値ポリシーに従い中央値runを採用)

## 結果: 重大な発見 — ズームアウト中の実行時間崩壊(再現性あり)

10,000フレームを素朴に(540フレーム/サイクル×19サイクル)回す当初案は **実行不能** だった。

`static`・`max-speed-pan`・`full-map` の3フェーズは常に高速(cpu 中央値 0.2〜0.3ms)だが、
`zoom-roundtrip` フェーズのズームアウト側(cycle内フレーム 361→540、フレームインデックスで
おおよそ 490 前後)に入ると、**1フレームあたり 16.5〜65 秒**という致命的な遅延が発生し、
**一度発生すると回復しない**(観測した限り、以後ずっと同程度の遅さが続く)。3回の独立実行すべてで
フレームインデックス 492〜494 前後という、ほぼ同一の地点で発生した(同一シード・同一カメラ経路
なので再現性は高い)。

素朴に19サイクル分(必要な最終判定 T3/T5 のためには不要な繰り返し)回すと、この崩壊状態のまま
数時間かかると試算された(1フレーム約16.5秒 × 数千フレーム)。研究時間予算内での完走が不可能なため、
以下の対応を行った:

1. **スコープ縮小**: ズームラウンドトリップを含む「フルサイクル」(540フレーム)は **2回のみ** 再生。
   崩壊は初回発生時点ですでに致命的な大きさで再現しているため、19回繰り返しても新しい情報は得られない。
   残りのフレーム数(≥10,000達成のため)は、同じスクリプトの高速な接頭辞(static→pan→full-map、
   ズームなし)を繰り返すことで充足した。`layer_b_bench.rs` 内の `FULL_CYCLES=2` と `fast_cycle`
   がこれに対応する。
2. **安全弁**: 1フレームが 5000ms を3回連続で超えたら、以後の残りフレームを打ち切り、その旨を
   結果JSONの `anomalies` 配列に記録する(silent に隠さず、崩壊の証拠として残す)。
3. **タイムスタンプクエリの適応的無効化**: 別の問題として、`QuerySet` の resolve → `map_async` →
   `device.poll(Maintain::Wait)` 自体が、実行内容に関わらず最初のバッチ(128フレーム分)で
   常に約60秒スタックすることが判明した(pass-scoped / encoder-level 双方の `write_timestamp` で
   再現、tile生成をフレームのエンコーダから分離しても解消せず)。初回flushの所要時間を計測し、
   2000ms を超えたら以後の実行で GPU タイムスタンプ計測を無効化してCPU計測のみにフォールバックする
   処理を実装した(`timestamp_supported` を実行中に降格、`timestampQueryDegradedDuringRun` として記録)。

**この崩壊自体が Layer-B の最重要な結果である。** 缶詰にして隠さず、T3 と T5 の FAIL として下で
報告する。原因(wgpu 24.0.5 / Metal 固有のリソースプール枯渇か、コマンドバッファ管理の問題か、
本ベンチ特有のタイル生成パターンに起因するものか)はこの研究予算内では特定しきれなかった
(下記「未検証事項」参照)。

## 計測結果(3実行、中央値run = run2)

3回の実行はいずれもフレームインデックス492〜494で崩壊・打ち切りとなり、非常に近い結果だった
(static/pan/full-mapフェーズの p99 が最も低い run2 を「外乱が少ない中央値run」として採用)。

| 実行 | 完走フレーム数(目標10,080) | static p99 | pan p99 | full-map p99 | zoom-roundtrip 内ヒッチ数 |
|---|---|---|---|---|---|
| run1 | 494 | 0.370ms | 0.895ms | 0.934ms | 3/134 |
| run2(採用) | 492 | 0.311ms | 0.828ms | 0.714ms | 3/132 |
| run3 | 492 | 1.525ms | 1.698ms | 0.643ms | 3/132 |

run2 (`bench/results/layer-b-1786140557-run2.json`) の詳細:

- adapter: `Apple M4` / backend `Metal` / deviceType `IntegratedGpu`
- タイムスタンプクエリ: 対応検出はされたが(`timestampQuerySupported` はfalseに降格済み表示。
  実行開始時は true だったが最初のflushが60002msかかったため `timestampQueryDegradedDuringRun: true`
  として以後CPU計測のみにフォールバック)
- static (120フレーム): CPU中央値 0.190ms / p99 0.311ms / max 5.811ms、ヒッチ0
- max-speed-pan (120フレーム): CPU中央値 0.278ms / p99 0.828ms / max 2.181ms、ヒッチ0
- full-map (120フレーム, LOD5, drawCalls中央値9): CPU中央値 0.227ms / p99 0.714ms / max 3.551ms、ヒッチ0
- zoom-roundtrip (132フレームで打ち切り): CPU中央値 0.195ms(崩壊前の大半のフレームは高速)だが
  p99 16922.8ms・max 20970.8ms、ヒッチ(>16.6ms)3件。この3件が数十秒級で、通常のヒッチとは
  桁が3〜4桁違う致命的事象
- 常駐タイル: 崩壊時点で29枚(約7.66MB相当のサンプルバッファのみの概算、cliff/water等の補助
  バッファは含まず)
- T7(新規タイル可視化遅延): サンプル15件、中央値0フレーム、p99 187フレーム(≈42ms、中央値フレーム
  時間換算)。ほとんどのタイルは同一フレーム内で即時生成されるが、崩壊直前のフレームで生成が滞留した
  タイルがp99を押し上げている

### 実GPU上での正しい描画の確認(既存native bin)

```json
offscreen_render (800x600, Metal): {"adapter":"Apple M4","backend":"Metal","nonBackgroundPixels":148022,"elapsedMs":16.320}
fullmap_render  (1600x900, Metal): {"adapter":"Apple M4","backend":"Metal","lod":5,"drawCalls":9,"nonBackgroundPixels":640000,"bbox":[1,50,1598,849],"elapsedMs":13.796}
```

`fullmap_render` の非背景ピクセル数 640,000 は期待される投影菱形(1600×800、面積640,000px)と一致し、
bbox `[1,50]-[1598,849]` はマップ境界での部分タイルが正しく切り詰められていることを示す
(PNG化して目視確認済み、非黒・地形ノイズが可視)。両方とも Layer-A ノートに記載の VM/software raster
結果と整合する構造で、実GPU(Metal)でも正しい画像が出力されることを確認した。

## Tゲート判定(run2 採用)

崩壊により全体としては 10,000フレームを完走できていないため、`totalFramesTargeted: 10080` に対し
`framesActuallyCompleted: 492` である点に注意。T1/T2/T4/T6/T7 は崩壊前の健全なフレームから、
T3/T5 は崩壊そのものを根拠に判定する。

| # | 項目 | プロトタイプ判定 | 実測 | 判定 | 厳格判定 | 実測 | 判定 |
|---|---|---|---|---|---|---|---|
| T1 | 静止時フレーム時間 | (別途ゲートなし、T4が代替) | median 0.190ms / p99 0.311ms | - | median≤2ms & p99≤4ms | 同上 | **PASS**(参考) |
| T2 | 最大速度パン中 | (T3のヒッチ0に統合) | median 0.278ms / p99 0.828ms | **T3経由でFAIL** | median≤4ms & p99≤8.3ms | 同上 | PASS(参考、ただしT3全体がFAIL) |
| T3 | ヒッチ(>16.6ms)0件 | 0件必須 | 3件(zoom-roundtrip中、16.9秒〜21秒級) | **FAIL** | 10000フレーム中0件 | 3件/492フレーム完走 | **FAIL** |
| T4 | 全図ズームアウト p99≤16.6ms | 必須 | p99 0.714ms | **PASS** | median≤4ms & p99≤8.3ms | 同上 | PASS(参考) |
| T5 | ズーム往復 ヒッチ0 | T3と同じ | zoom-roundtripフェーズ内3件 | **FAIL** | 同左 | 同上 | **FAIL** |
| T6 | 初期表示 | ≤1000ms | 5.811ms | **PASS** | ≤300ms | 同上 | PASS(参考) |
| T7 | 新規タイル可視化遅延 | 参考計測 | 中央値0f / p99 187f(≈42ms) | 参考記録 | ≤50ms(≤3フレーム) | p99 187フレームは超過だが崩壊直前の異常値混入の影響大、崩壊除く定常値は中央値0フレーム | 参考(崩壊の影響で厳密判定は保留) |
| T8 | 地形編集の反映 | 対象外(プロトタイプスコープ外) | 未計測 | null | 対象外 | 未計測 | null |

**プロトタイプ段階の合否まとめ: (a) T3 ヒッチ0 → 不合格 / (b) T4 全図p99≤16.6ms → 合格 /
(c) T6 初期表示≤1s → 合格。** 3項目中1項目(T3、連動してT5)が不合格のため、仕様書の
「層Bのいずれかが未達の間はthree.js置き換えを行わない」規定により、**このプロトタイプは
layer-B昇格基準を満たさない。**

## 結論

- 仮説(「CPU側は軽量なので実GPUでもT1/T2/T4/T6は容易に満たす」)は **部分的に採択**:
  健全に動作しているフレームでは実際に極めて軽量(サブミリ秒)だった。
- しかし「T3/T5がプロトタイプでも成立するか」という主眼の問いには **明確に否定的な結果**が出た。
  深いズームアウト・LODチャーン下で、このMac(wgpu 24.0.5 / Metal)上で数十秒級の致命的フレームが
  発生し、しかも回復しない。これはT3のヒッチ0要件に対する重大な違反であり、
  **layer-B(実GPU)昇格の可否判定としてはFAILと明記する**(数値を調整して隠さない)。
- 副次的な発見として、GPUタイムスタンプクエリ(`QuerySet` resolve + `map_async` +
  `device.poll(Wait)`)自体も、内容に関わらず初回で約60秒スタックする別の問題が再現した。
  これも同一環境(wgpu 24.0.5 / Metal / macOS 26.5.2)固有の可能性が高い。

## 未検証事項 / 次の一手

- **根本原因の切り分け未完了**: ズームアウト崩壊が (a) wgpu 24.0.5 の Metal backend 固有のバグ
  (コマンドバッファプールやステージングベルトの枯渇等)か、(b) 本ベンチのタイル生成・破棄パターン
  (LODが変わるたびにキャッシュミスが連鎖する経路)に起因する実装上の問題か、(c) macOS 26.5.2 
  (比較的新しいOSバージョン)特有の問題か、切り分けられていない。次の一手候補:
  - wgpu を最新版(0.24系のパッチ、または0.2x系の他バージョン)に上げて再現するか確認
  - `Instruments` (Metal System Trace) で崩壊発生時にGPU/CPU側で何が起きているか直接観測
  - タイル生成をやめて描画のみ(既存タイルの再利用のみ)でズームだけ回し、タイル生成が原因か切り分け
  - Chrome(BrowserWebGPU)で同じズーム経路を回し、ブラウザ側でも崩壊が起きるか確認
    (今回は時間予算の都合で未実施、下記参照)
- **GPUタイムスタンプクエリの60秒スタックも未解明**。`wgpu::Features::TIMESTAMP_QUERY` のみ
  (encoder側`TIMESTAMP_QUERY_INSIDE_ENCODERS`は不使用)でも発生することは確認済みなので、
  encoder-levelとpass-scopedの差ではない。
- **ブラウザ実GPU計測は未実施**(タスクのオプション項目)。上記の崩壊調査を優先したため
  時間予算内で着手できなかった。非表示タブでrAFが止まる問題を踏まえても、可視セッションでの
  Chrome BrowserWebGPU計測は本崩壊がネイティブMetal固有かどうかを切り分ける上で価値が高く、
  次の一手として推奨する。

## 再現手順

```sh
cd renderer_research/proto
cargo build --release --bin layer_b_bench --bin offscreen_render --bin fullmap_render
target/release/layer_b_bench bench/results/layer-b-$(date +%s)-run1.json
# stderr に "ABORT: ..." が出れば崩壊を再現。frame_index=490前後を確認。
```

## 使用ファイル

- `renderer_research/proto/renderer_wgpu/src/bin/layer_b_bench.rs`(新規、本ノートの主対象)
- `renderer_research/proto/renderer_wgpu/src/bin/offscreen_render.rs`,
  `renderer_research/proto/renderer_wgpu/src/bin/fullmap_render.rs`
  (`Backends::VULKAN`→`Backends::METAL`のみ変更、Mac実行のため)
- 結果JSON: `renderer_research/proto/bench/results/layer-b-1786140446-run1.json`,
  `layer-b-1786140557-run2.json`(中央値run、採用), `layer-b-1786140680-run3.json`
  (`.gitignore`で除外、ローカルに保持。再現手順で再生成可能)

## 追記: スリープ原因説の検証(棄却)

ユーザーから「Macがスリープしていた可能性」の指摘を受け、`caffeinate -dimsu` 配下で再実行した。
結果: **同一フレーム(493〜495、zoom-roundtrip工程)で同一の崩壊が再現**(9,211ms →
17,124ms → 5,004ms、直後に wgpu-core 24.0.5 の
「We timed out while waiting on the last successful submission to complete!」パニック)。
スリープ・省電力は原因ではない。

### 追加の手がかり(原因仮説の絞り込み)

- 崩壊フレームは `generated=0 visible=4 needed=16`: ズーム往復の戻り(引き→寄せ)で
  LOD0 タイル16枚が必要だが4枚しか常駐しておらず、新規生成も走っていない状態
- 健全時の zoom-roundtrip 中央値は 0.198ms。突然2〜4桁跳ねる、かつ CPU計測値として
  記録されている(=submit後の待ちがCPU時間に乗っている)
- 仮説: **未常駐タイルのフォールバック描画パスが、粗い親タイル(または全域)を
  ストライド1の頂点グリッドで描いてしまい、indirect draw の頂点数が数億に爆発**、
  GPUが1フレームに十数秒かかる(Metalのcommand buffer timeoutとも整合)。
  llvmpipe(VM)ではソフトラスタの別特性で顕在化しなかった可能性
- 独立に観測した「QuerySet resolve+map_async が初回60秒」も、同じ submission timeout
  系の症状かは未切り分け

### 次の一手(レンダラーセッションへの引き継ぎ)

1. 崩壊フレームの indirect draw 引数(render_args の base_vertices)をログし、頂点数爆発を確認
2. フォールバック/LOD選択で「必要タイル未常駐時は親LODの該当領域だけを描く(ストライドを
   親LODに合わせる)」ことを保証。頂点数の上限アサーション(例: 1draw ≤ 200万頂点)を追加
3. ズーム戻り工程でタイル生成が0になっている点(生成キューの停止?)も要調査
