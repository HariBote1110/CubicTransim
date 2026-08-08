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
- GPU adapter: `Apple M4` / backend `Metal` / device type `IntegratedGpu`
- Rust: rustc 1.93.0 / cargo 1.93.0
- wgpu: 24.0.5 / リリースビルド
- 対象: `renderer_research/proto/renderer_wgpu/src/bin/layer_b_bench.rs`、`src/lib.rs`(wasm CanvasRenderer)、
  `shaders/{tile_finalize,terrain_draw,tile_clamp_args}.wgsl`

## 経緯: 第1回計測での「崩壊」と、その根本原因の特定

第1回の計測(初版ノート)では、`zoom-roundtrip` フェーズのフレーム493〜495付近で
**1フレーム 9.2s → 17.1s → 5.0s** という致命的遅延が起き、直後に wgpu-core の
「We timed out while waiting on the last successful submission to complete!」で落ちた。
3回の独立実行すべてで同じフレーム位置に再現し、`caffeinate -dimsu` 下でも再現したため
スリープ・省電力は棄却済みだった。当時の手がかりは `generated=0 visible=4 needed=16` のみで、
「未常駐タイルのフォールバック描画がストライド1で全域を描いて頂点数が爆発している」
「ズーム戻り工程でタイル生成キューが止まっている」という2つの仮説を立てていた。

今回、安全弁を先に入れたうえで実際の indirect draw 引数を読み戻し、**根本原因を確定した。
2つの仮説はどちらも外れており、真因はもっと単純かつ全フレームに存在していた。**

### 確定した根本原因: indirect draw 引数のフィールド食い違い

`tile_finalize.wgsl` は描画引数バッファをこう宣言していた:

```wgsl
struct RenderArgs {
  total_vertices: atomic<u32>,
  cliff_vertices: atomic<u32>,
  water_vertices: atomic<u32>,
  instance_count: atomic<u32>,
};
```

一方 `draw_indirect` が読むワイヤ表現は `(vertex_count, instance_count, first_vertex, first_instance)`。
つまり **`cliff_vertices` が instance_count に、`water_vertices` が first_vertex に、
そのまま流し込まれていた**。崖エッジ1本につき `atomicAdd(&args.cliff_vertices, 6u)` するので、
崖の多いタイルほど instance_count が数万に膨れる。

### 証拠(LAYER_B_ARG_TRACE=1 で全タイルの要求引数を読み戻し)

```
OVER-CAP DRAW: frame=1 tile=(lod=0,x=-1,z=-1) requested vertex_count=422460 instance_count=29244
  first_vertex=0 first_instance=1 -> clamped to vertex_count=422460 instance_count=1 (cap 2000000);
  total vertex invocations would have been 12354420240
OVER-CAP DRAW: frame=1 tile=(lod=0,x=-1,z=0)  requested vertex_count=425448 instance_count=32232
  first_vertex=0 first_instance=1 -> ... would have been 13713039936
```

- **フレーム1**から、可視4タイルすべてが 1draw あたり **123〜137億頂点** を要求していた。
  4タイル合計でおよそ **500億頂点/フレーム**。観測した最大要求 instance_count は 61,350
- フレーム493は「そこで何かが壊れた地点」ではなく、**非同期に積み上がったGPUバックログを
  CPUがついに待たされ始めた地点**にすぎない。CPU側の計測(`cpu_ms`)は submit までしか測って
  いないため、GPUが数百フレーム分遅れていても崩壊直前まで sub-ms に見えていた
- 崩壊フレームのトレース(修正後・クランプ有効時に再取得):
  `frame=493 phase=zoom-roundtrip ppc=22.99 lod=0 visible=4 resident_visible=4 needed=16 generated=0
   resident_total=29` — **可視4タイルはすべて常駐済み**

### 旧仮説の棄却

- **「未常駐タイルのフォールバック描画が細かいストライドで描いている」→ 棄却**。
  そもそもフォールバック描画パスは存在しない。`lib.rs`/`layer_b_bench.rs` とも
  `if let Some(tile) = tiles.get(&key)` で未常駐タイルは単にスキップする。
  頂点数の爆発は stride ではなく instance_count 側で起きていた
- **「ズーム戻りで生成キューが止まっている(generated=0)」→ 棄却**。
  `generated=0` はキューの停止ではなく **キャッシュが温まっていただけ**。同フレームの
  `resident_visible=4`(可視4枚すべて常駐)・`resident_total=29` が示すとおり、
  必要なタイルは全部そろっていた。`needed=16` は prefetch_border=1 の 4×4 集合で、
  可視2×2に対する正常値
- **「QuerySet resolve+map_async が初回だけ約60秒」→ 同一原因だった**。
  `device.poll(Maintain::Wait)` は本当にGPUの完了を待っていただけで、60秒は
  wgpu-core の submission 待ちタイムアウト。修正後の flush は **58〜158ms**
  (128フレーム分のGPU work を実際に流し切る時間)で、GPUタイムスタンプは正常に機能する。
  環境固有の不具合ではなかったため、CPU計測フォールバックへの降格も発生しなくなった

## 修正内容

1. **描画セーフガード(恒久不変条件)** — `shaders/tile_clamp_args.wgsl`
   タイル生成直後に1回だけ走る計算パス。要求された引数を診断領域(word 8..11)にそのまま記録し、
   `vertex_count` を `MAX_DRAW_VERTICES`(2,000,000)に、`instance_count` を1にクランプしてから
   でなければ `draw_indirect` に渡らないようにした。1タイルが正当に出しうる最大頂点数は
   `256×256×6 + 6×130,560 + 6×65,536 = 1,569,792` なので、2,000,000 は余裕を残しつつ
   エンコード不整合を確実に捕まえる。`LAYER_B_ARG_TRACE=1` でCPU側に読み戻し、
   上限超過をパラメータ付きでログ(debug ビルドでは `debug_assert`)
2. **根本修正** — `RenderArgs` をワイヤ表現に合わせて並べ替え(48バイト化)。
   word 0..3 が draw quad、word 4..5 が `cliff_vertices`/`water_vertices`、word 8..11 が診断領域。
   `terrain_draw.wgsl` の頂点範囲分割も同じレイアウトに追随。wasm 側 `CanvasRenderer` にも
   同じ修正とクランプパスを適用
3. **ベンチの安全弁** — 単一フレームが2000msを超えた時点で即中断し `anomalies` に記録
   (旧: 5000ms×3連続)
4. **スコープ縮小の撤廃** — 旧版はズーム脚を2サイクルしか回さず残りを高速プレフィクスで
   埋めていた(`FULL_CYCLES=2` + `fast_cycle`)。修正後は **540フレームの完全サイクルのみ**で
   10,260フレームを回す
5. **描画結果の退行検出** — 最終フレームの非背景ピクセル数を結果JSONに出力。
   `instance_count=0` のような「何も描かれない」退行を検出できる
6. **T7の計測対象の是正** — プリフェッチ境界タイルまで計測開始点にしていたため、
   「まだ見えていない・数百フレーム後に視界へ入るタイル」がサンプルに混ざり p99 が
   528フレームに膨らんでいた。可視集合に入った未常駐タイルのみを対象にした

## 計測結果(修正後、3実行・完全スクリプト)

3実行とも **10,260フレーム完走・ヒッチ0件・打ち切り0件**。ばらつきは極小。

| 実行 | 完走 | ヒッチ | static p99 | pan p99 | full-map p99 | zoom p99 |
|---|---|---|---|---|---|---|
| run1(採用・中央値) | 10260 | 0 | 1.774ms | 1.216ms | 3.427ms | 3.208ms |
| run2 | 10260 | 0 | 1.682ms | 1.276ms | 3.384ms | 3.396ms |
| run3 | 10260 | 0 | 1.734ms | 1.176ms | 3.496ms | 3.339ms |

採用 run1 (`bench/results/layer-b-final-1786172315-run1.json`) の詳細
(`totalMs` = CPU + GPUタイムスタンプ実測):

- 環境: `Apple M4` / `Metal` / `IntegratedGpu`、`timestampQuerySupported: true`、
  `timestampQueryDegradedDuringRun: false`
- 構成: 540フレーム×19サイクル = 10,260フレーム、`zoomLegScopeNote: "none: every frame comes
  from the complete 540-frame cycle including both zoom legs"`、`anomalies: []`
- static (2280f, LOD0, draws 4): cpu median 0.049ms / gpu median 0.571ms /
  **total median 0.627ms・p99 1.775ms・max 9.279ms**、ヒッチ0
- max-speed-pan (2280f, LOD0, draws 2): cpu median 0.038ms / gpu median 0.302ms /
  **total median 0.349ms・p99 1.216ms・max 2.578ms**、ヒッチ0
- full-map (2280f, LOD5, draws 9): cpu median 0.039ms / gpu median 1.764ms /
  **total median 1.830ms・p99 3.427ms・max 4.851ms**、ヒッチ0
- zoom-roundtrip (3420f, LOD0, draws 4): cpu median 0.047ms / gpu median 0.577ms /
  **total median 0.636ms・p99 3.208ms・max 7.867ms**、ヒッチ0
- 描画セーフガード: `overCapDraws: 0`、`finalFrameNonBackgroundPixels: 469442`
  (最終フレームは全図フェーズ。地形が実際に描かれていることを確認)
- 常駐タイル: 45枚 / 上限384枚、サンプルバッファ概算 11,888,820 バイト
- T7: サンプル13件、median 0フレーム / p99 0フレーム(可視タイルは常に同一フレーム内で生成完了)

### 実GPU上での正しい描画の確認(既存native bin)

```json
offscreen_render (800x600, Metal): {"adapter":"Apple M4","backend":"Metal","nonBackgroundPixels":148022,"elapsedMs":16.320}
fullmap_render  (1600x900, Metal): {"adapter":"Apple M4","backend":"Metal","lod":5,"drawCalls":9,"nonBackgroundPixels":640000,"bbox":[1,50,1598,849],"elapsedMs":13.796}
```

`fullmap_render` の非背景ピクセル数 640,000 は期待される投影菱形(1600×800)と一致。
なおこの2つは `terrain_draw_surface.wgsl` + `draw_indexed` の別経路であり、今回の
indirect 経路のバグの影響を受けていなかった(だからこそ第1回計測時に「描画は正しい」と
判断でき、原因の切り分けが遅れた)。

## Tゲート判定(run1 採用、10,260フレーム完走)

| # | 項目 | プロトタイプ判定 | 実測 | 判定 | 厳格判定 | 判定 |
|---|---|---|---|---|---|---|
| T1 | 静止時フレーム時間 | (T4が代替) | median 0.627ms / p99 1.775ms | **PASS** | median≤2ms & p99≤4ms | **PASS** |
| T2 | 最大速度パン中 | (T3に統合) | median 0.349ms / p99 1.216ms | **PASS** | median≤4ms & p99≤8.3ms | **PASS** |
| T3 | ヒッチ(>16.6ms)0件 | 0件必須 | **0件 / 10,260フレーム** | **PASS** | 10000フレーム中0件 | **PASS** |
| T4 | 全図ズームアウト p99≤16.6ms | 必須 | median 1.830ms / p99 3.427ms | **PASS** | median≤4ms & p99≤8.3ms | **PASS** |
| T5 | ズーム往復 ヒッチ0 | T3と同じ | ズーム脚 0件 / 3,420フレーム | **PASS** | 同左 | **PASS** |
| T6 | 初期表示 | ≤1000ms | 9.278ms | **PASS** | ≤300ms | **PASS** |
| T7 | 新規タイル可視化遅延 | 参考計測 | median 0f / p99 0f (n=13) | **PASS** | p99≤50ms(≤3フレーム) | **PASS** |
| T8 | 地形編集の反映 | 対象外(プロトタイプスコープ外) | 未計測 | null | 対象外 | null |

**プロトタイプ段階の合否まとめ: (a) T3 ヒッチ0 → 合格 / (b) T4 全図p99≤16.6ms → 合格 /
(c) T6 初期表示≤1s → 合格。3項目すべて合格。**
さらに **本実装向けの厳格値 T1/T2/T4/T5/T6/T7 もすべて合格**した(T8のみプロトタイプ
スコープ外で未判定)。

## 結論

- 当初の仮説(「CPU側は軽量なので実GPUでもT1/T2/T4/T6は容易に満たす」)は **採択**。
  CPU側は全フェーズで median 0.05ms 未満、GPU側も全図(LOD5, 9draw)で median 1.8ms
- 主眼だった「T3/T5がプロトタイプでも成立するか」も **成立**。10,260フレームで
  16.6ms超のフレームは1件も出ていない
- 第1回計測でFAILとしていた T3/T5 は、**ハードウェアやwgpu/Metalの問題ではなく
  プロトタイプ自身の描画引数エンコードのバグ**だった。60秒スタックも同一原因の別症状。
  「環境固有の未解明問題」と結論づけずに引数を実測したことで確定できた
- 教訓: indirect draw は引数バッファのワイヤ表現が唯一の契約であり、WGSL側の
  struct フィールド名は何の保証にもならない。今回入れた頂点数クランプは、
  この種の不整合を「OSごと巻き込むハング」ではなく「ログ1行」に変えるための
  恒久的な安全弁として残す

## 未検証事項 / 次の一手

- **T8(地形編集連打)は未計測**。プロトタイプスコープ外のため意図的に未実装
- **ブラウザ実GPU計測は未実施**。今回の修正は wasm 側 `CanvasRenderer` にも同じ形で
  入っているが、Chrome BrowserWebGPU 上での実測はまだ行っていない。ネイティブMetalで
  全ゲート合格したので、次はブラウザ側で同じスクリプトを回して確認するのが妥当
- **本実装(three.js置き換え)側への移植時の注意**: `tile_clamp_args.wgsl` のクランプパスと
  `MAX_DRAW_VERTICES` 不変条件は必ず一緒に移植すること

## 再現手順

```sh
cd renderer_research/proto
cargo build --release --bin layer_b_bench
caffeinate -dimsu ./target/release/layer_b_bench bench/results/layer-b-$(date +%s)-run1.json
# 3回実行し中央値runを採用。anomalies が空・全フェーズ hitchesOver16_6ms=0 が期待値。

# 描画引数のトレース(頂点数爆発の再確認・回帰検出用)
LAYER_B_ARG_TRACE=1 LAYER_B_TRACE_FROM=1 LAYER_B_TRACE_TO=600 \
  ./target/release/layer_b_bench bench/results/trace.json
# "OVER-CAP DRAW:" が1行でも出れば引数エンコードが壊れている。
```

環境変数: `LAYER_B_TARGET_FRAMES`(既定10000)、`LAYER_B_FORCE_NO_TS`(GPUタイムスタンプ無効化)、
`LAYER_B_ARG_TRACE` / `LAYER_B_TRACE_FROM` / `LAYER_B_TRACE_TO`。

## 使用ファイル

- `renderer_research/proto/renderer_wgpu/src/bin/layer_b_bench.rs`
- `renderer_research/proto/renderer_wgpu/src/lib.rs`(wasm `CanvasRenderer`)
- `renderer_research/proto/renderer_wgpu/shaders/tile_clamp_args.wgsl`(新規)、
  `tile_finalize.wgsl`、`terrain_draw.wgsl`
- 結果JSON: `bench/results/layer-b-final-1786172315-run{1,2,3}.json`
  (`.gitignore` で除外。数値は本ノートに転記済み。再現手順で再生成可能)
