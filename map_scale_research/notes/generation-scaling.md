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

## 次の一手 / 未検証事項

- **GPU フレーム時間の実測**(表示状態のタブでの FPS)。非表示タブ制約で未計測。CPU側指標からは問題の兆候なし
- **建設・町成長時のジオメトリ再マージのヒッチ**。useMemo の全再構築が O(コンテンツ量) なので、
  巨大マップで線路網・町が育ちきった終盤に1回の建設で何ms止まるかは未測定(差分マージ化の余地)
- **列車数十編成時の stepWorld / DynamicTrain 描画**(今回は列車0編成)
- 実採用時は湖の数・町の数・TOWN_COORD_RANGE を面積比例でスケールさせること
  (今回は towns=64・範囲240 をハードコードで仮置き)
- 旅客の重力モデル・経路探索は駅数依存(マップ面積そのものには非依存)なので今回未測定
