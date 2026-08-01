# 標高の一次データ化と「がっつり高低差」の地形生成 (v0.3.0)

## 目的

従来の地形は `Map<string, TerrainType>`('water'|'mountain')だけを保存し、標高は
`computeElevation`(mountainセルの縁からのマンハッタン距離、最大3段)で毎回導出していた。
これを逆転し、**標高 `heights: Map<string, number>`(セルごとの整数段数、未登録=0)を
一次データ**として持たせ、地形種別を標高から導出する。あわせて最大段数を3→10
(`TERRAIN_HEIGHT_MAX`)へ引き上げ、丘・谷・尾根のあるがっつりした高低差のマップを生成する。

## 生成パイプライン (`sim/terrain.ts` の `generateMap`)

1. `generateHeights(rng)` — フラクタル値ノイズ(3オクターブ、波長22/11/5.5、振幅1/0.5/0.25、
   smoothstep補間)。格子点の乱数はrngから引いたシードによる決定的ハッシュ(`hashLattice`)。
   合成ノイズに平地バイアス(`FLATLAND_THRESHOLD=0.52` 以下は標高0)を掛けてから
   `HEIGHT_GAIN=26` 倍・四捨五入・`TERRAIN_HEIGHT_MAX=10` でクランプ。
2. 湖は従来の `carveLake`(ランダムウォーク)をそのまま使い、waterセルの標高を0に強制。
3. `normaliseHeights` — 2パスのチャンファー距離変換で
   `result(c) = min_d (h(d) + マンハッタン距離(c,d))` を厳密計算し、
   **4近傍の段差が必ず1以下(1-Lipschitz)** になるよう引き下げのみで正規化する。
   コーナー標高のmin則(`cornerElevation`)が連続斜面を保証するのはこの性質が前提。
   範囲外は標高0の固定点として扱うのでマップ端も安全。プロパティテストで検証済み。
4. 標高 `MOUNTAIN_HEIGHT_THRESHOLD` 以上の陸セルを 'mountain' にする。

実測(シード7種): 平地(標高0の陸地)56〜67%、最高標高7〜10、水域64〜113セル。
街8つは全シードで平地に生成できる。

## 主要な設計判断: MOUNTAIN_HEIGHT_THRESHOLD = 1

**「盛り上がったセルはすべてmountain」**とした。当初案(しきい値5、標高1〜4は
「建設可能ななだらかな草地」)は、地上線路・駅・列車の描画を段丘の高さへ持ち上げる
大改修(trackPath/consist/simulationのy座標、駅・車庫の描画、坂の接続規則)を伴うため
見送り、小さく正しい変更を選んだ。しきい値1の帰結:

- 地上の建設(線路・駅・車庫・信号)は従来どおり**標高0の平地のみ**。
  「4隅の高さが等しいセルだけ許可する」新チェック(`pathHasUnevenGroundCell` 案)は
  不要になった(標高>0のセルは全部mountainで、既存のmountain規則が引き受けるため)。
- 盛り上がった地形は既存のトンネル規則がそのまま適用される:
  坑口セル(非mountain隣接に接続)か、天井が覆われた内部セル(4隅コーナー標高>=1)のみ敷設可。
- **mountain ⟺ 標高>=1** なので、「コーナー標高>=1」のトンネル内部判定は
  `computeElevation(terrain)`(旧導出)でも `heights`(一次データ)でも同一の結果になる。
  これにより construction.ts の既存テスト(旧導出前提)と実挙動(heights)が矛盾しない。
  `applyRailPathDetailed`/`applyRailPath` には省略可能な `heights` 引数を追加した
  (省略時は旧来どおり `computeElevation(terrain)` へフォールバック。buildPreviewの
  プレビュー経路は省略のままだが、上記の等価性により結果は同じ)。

段丘上(高標高の平坦なテラス)への地上線路は将来の拡張候補として残す。

## 変更ファイル

- `src/sim/terrain.ts` — `generateHeights`/`normaliseHeights`/`generateMap` 新設。
  `carveMountain`/`dilateMountains`/`generateTerrain`(山脈ランダムウォーク系)は削除。
  `computeElevation` は**旧セーブ(v13以前)移行専用**として残置(`MOUNTAIN_ELEVATION_MAX=3`も)。
- `src/sim/persistence.ts` — SaveData v14(`heights: [string, number][]`)。
  v13以前の読み込みは `computeElevation(terrain)` でheightsを補う(最大3段の従来の見た目のまま)。
- `src/sim/simulation.ts` — `SimWorld.heights?` 追加。
- `src/sim/construction.ts` — `applyRailPath(Detailed)` に省略可能な `heights` 引数。
- `src/sim/towns.ts` — `isNearTerrain` をterrain全走査からO(半径²)の直接参照へ書き換え
  (mountainセルが数千個規模になったため。街は従来どおり平地のみ、しきい値1により
  「平地=標高0」が自動的に保証される)。
- `src/hooks/useGameLogic.ts` — `generateMap` で terrain/heights を同時生成、
  `heights` state と worldRef 同期、セーブ/ロード/デバッグシナリオ対応。
- `src/components/GameScene.tsx` — 坑口・高架トンネル判定の標高を
  `computeElevation` 導出から `heights` prop へ変更。
- `src/components/TerrainBlocks.tsx` — `heights` prop を描画の標高源に。雪化粧のしきい値を
  固定3段から `TERRAIN_HEIGHT_MAX - 2`(=8)へ変更。
- `src/App.tsx` — heights の受け渡し。

## テスト

- terrain.test.ts を全面書き換え: 生成の決定性・値域・範囲、normaliseHeightsの
  1-Lipschitzプロパティテスト(ランダム入力5シード)・引き下げのみ・冪等性、
  generateMapの water=標高0 / mountain⟺標高>=しきい値 / 最高標高>=6 / 平地30%以上。
  旧 `dilateMountains`/`generateTerrain` テストの意図(決定性・範囲クランプ・Lipschitz)は
  新テストへ移植した上で削除。
- persistence.test.ts: v14ラウンドトリップ + v13→v14移行(computeElevation導出) + v14そのまま復元。
- towns.test.ts: generateMapの実マップで街8つが必ず平地(標高0の草地)に湧くこと。

580 → **590 passed**、`tsc -b` クリーン、`npm run build` 成功。
