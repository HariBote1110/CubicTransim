# 頂点・インスタンスバッファのアップロード経路

## Decision

メッシュチャンクとインスタンス配列を GPU へ載せる経路から、中間の `Vec<u8>` を廃した。
`create_buffer_init` をやめ、`mapped_at_creation: true` でバッファを作り、そのマップ領域へ
直接書き込む。

そのため `meshes.rs` の API を「サイズ計算」と「書き込み」に分けた。

| 旧 | 新 |
| --- | --- |
| `interleave_vertices(pos, col) -> Vec<u8>` | `interleaved_vertex_bytes(pos, col) -> usize` + `interleave_vertices_into(dst, pos, col)` |
| `split_instances_by_class(data) -> (Vec<u8>, Vec<u8>)` | `underground_instance_count(data) -> usize` + `split_instances_into(surface, underground, data)` |

サイズを先に求めるのは、マップ領域を確保するのにバイト数が要るため。インスタンスの
振り分けは地下の件数を数えてから2本のバッファをちょうどのサイズで作る(旧実装は両方に
全件分を予約していたので、実際の2倍を確保していた)。

書き込みループは `chunks_exact` / `chunks_exact_mut` 同士の `zip` にした。境界チェックが
消えて 12 バイトのコピーがベクトル化され、要素ごとに書くより 2〜3 倍速い。

計測(200k頂点 / 100kインスタンス・地下1割、best-of-5、確保量はグローバルアロケータで実測):

| | 時間 | 確保量 |
| --- | --- | --- |
| interleave 旧(main) | 0.318 ms | 3.2 MB |
| interleave PR#4 | 0.113 ms | 6.4 MB |
| interleave 本方式 | **0.068 ms** | **0 B** |
| split 旧(main) | 0.404 ms | 4.7 MB |
| split PR#4 | 0.210 ms | 8.0 MB |
| split 本方式 | **0.125 ms** | **0 B** |

## Alternatives considered

- **PR#4 の `vec![0u32; n]` + `to_vec()`**: 速いが、ゼロ埋めと最後のバイト列コピーで
  ピークメモリが出力サイズの2倍になる。確保ゼロにできる以上、採らない。
- **ちょうどのサイズの `Vec<u32>` を1回だけ確保して返す**: 0.157 ms / 3.2 MB。メモリは
  半減するが確保は残り、しかも `Vec::push` の容量チェックのぶん本方式より 2 倍遅い。
- **マップ領域を `&mut [u32]` へキャストして 4 バイト単位で書く**: 0.051 ms と最速だが、
  wgpu のマップ領域のアラインメントは API 上保証されていない。`try_cast_slice_mut` で
  失敗時にバイト単位へ落とす二段構えも書けるが、実際にはまず通らないフォールバック経路が
  常時死んだまま残る。0.068 → 0.051 ms の差(実チャンクでは数マイクロ秒)に見合わないと
  判断して、アラインメント非依存のバイト単位一本に絞った。

## Constraints / Gotchas

- **バイト順はネイティブ順**(旧実装は `to_le_bytes` で明示的にリトルエンディアン)。
  wasm32 は常に LE、ネイティブ実行も LE ホストしか想定していない。テストが LE 前提で
  assert しているので、BE ホストでビルドするとテストだけが静かに落ちる。
- `mapped_at_creation` はサイズが 0 だと作れない。頂点0件・インスタンス0件は
  `None` に倒して「チャンク削除」「そのクラスは描かない」として扱う。
- `*_into` は宛先が短ければ入る分だけ書いて残りを捨てる。JS からの呼び出しで
  長さが食い違ってもパニックさせないための防御で、テストで固定している。
- wasm の WebGPU バックエンドでは、マップ領域は wgpu が持つ一時バッファ経由で
  JS の ArrayBuffer へ書き戻される。つまり wgpu 側のコピーは残る。ここで消したのは
  「その手前にあった自前の中間バッファ」であって、コピー回数が 0 になるわけではない。
