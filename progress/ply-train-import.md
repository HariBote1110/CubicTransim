# Stormworks PLYモデルからの列車glbインポート

## 決定事項

- Stormworks からエクスポートした ASCII PLY(0.25グリッドのボクセルモデル、法線・頂点色つき)を
  `renderer/tools/ply_to_train_glb.mjs` で `public/models/trains/e233.glb` に変換する。
  純粋ロジックは `renderer/tools/plyMeshLib.mjs`(node:test/vitest でテスト、
  `renderer/tools/plyMeshLib.test.mjs`)。
- **実体ボクセルの復元**: 各面(三角形)は0.25セル境界上の軸並行矩形の半分(直角三角形)なので、
  そのバウンディングボックスは常にセル境界の正方形と一致する。頂点法線の平均を最寄りの軸単位
  ベクトル(±X/±Y/±Z)へスナップし、法線と逆方向のセルを実体ボクセルとみなす
  (`voxelizeFaces`)。占有隣接ボクセル投票のような複雑なヒューリスティックは不要だった
  — Stormworksの出力は法線が面ごとに一定で信頼できたため。同一ボクセルに複数面から異なる色が
  寄せられた場合は多数決。
- **間引き**: `downsampleVoxels(voxels, factor)` が整数係数でボクセルを間引き、子ボクセルの
  色は多数決で決める。CLIの `--voxel` (既定 1.25、実グリッド0.25の5倍)で間引き後のセルサイズを
  指定する。E233(KUHA/MOHA)実測: 実グリッドで約7000〜7500ボクセル、`--voxel 1.25`で
  280〜290ボクセルまで間引き。
- **メッシュ化**: `greedyMeshVoxels` が隠れ面(2つの実体ボクセルに挟まれた面)を除去し、
  軸・方向・色ごとに同色の矩形を貪欲統合(greedy meshing)してから2三角形化する。
  KUHA(先頭車→`car_head`)332三角形、MOHA(中間車→`car_mid`)386三角形(voxel=1.25時)。
  SAHA は今回未使用(将来 `car_tail` 専用形状が必要になれば流用できる)。
- **変換**: `transformTriangles` がX/Zをセンタリングし、最小Yを0へシフトし、Z幅(全長)が
  `TARGET_LENGTH=0.86`(train-model-format.md推奨値)になるよう一様スケールする。編成内の
  相対サイズを保つため、スケール係数は先頭車(KUHA)基準で算出し中間車(MOHA)にも同じ係数を
  適用する(中間車だけを別途0.86に合わせ直すと2両の縮尺がずれてしまうため)。`--flip`で
  Y軸180°回転(前後反転)に対応するが、どちらが実際の前面かは未検証(ブラウザ実機で違和感が
  あれば付け直すこと)。
- **色**: PLYの頂点色(uchar 0-255)をそのまま `baseColorFactor = [r/255,g/255,b/255,1]` に
  変換する。ガンマ補正は行わない — `bakedMesh.ts` のコメントに「sRGB値をそのまま係数として
  使う」とあり、`trainModelLoader.ts` も `baseColorFactor` を直接RGBとして頂点色へ焼き込む
  実装のため、変換方針を揃えた。
- **glb書き出し**: `buildTrainGlbBuffer`(plyMeshLib.mjs)が色ごとに1マテリアル+1プリミティブへ
  束ねてglbを組み立てる。既存の `glbTestFixtures.mjs` はテスト専用でノードあたり単一
  プリミティブ・マテリアルなし前提のため本番出力には使えず、別関数として新設した。頂点は
  非インデックス(三角形スープ)のまま出力(三角形数が数百程度なのでデデュープの複雑さに
  見合わない)。

## CLI 使用法

```bash
node renderer/tools/ply_to_train_glb.mjs \
  --kuha "Stormworks_train_model/E233 0 KUHA.ply" \
  --moha "Stormworks_train_model/E233 0 MOHA.ply" \
  --out public/models/trains/e233.glb \
  --voxel 1.25 \
  [--flip]
```

引数省略時は上記の既定パス・`--voxel 1.25`が使われる。実行時に
`renderer/tools/validate_train_glb.mjs` 相当の検査を自動実行し、結果と最終三角形数・AABBを
標準出力へ出す。

## 検証結果(voxel=1.25、flip無し)

- car_head(KUHA由来): 332三角形、AABB幅0.164×高さ0.205×全長0.860
- car_mid(MOHA由来): 386三角形、AABB幅0.164×高さ0.205×全長0.860
- `validate_train_glb.mjs` 総合判定: PASS(全項目)
- 出力ファイルサイズ: 約32KB(コミット対象)

## 代替案・却下したもの

- 「面ソープの隣接ボクセルへの投票(≥4面で実体とみなす)」ヒューリスティック: PLYの法線が
  面単位で正確・一定だったため不要と判断。実装コストと誤判定リスクを避けて法線ベースの
  直接復元を採用した。
- 元PLYの重い(6000万行超・200MB)ファイルはリポジトリへコミットせず、`.gitignore`に
  `Stormworks_train_model/` を追加した。再変換が必要な場合は同ディレクトリへ配置してから
  上記CLIを実行する。

## 未解決・フォローアップ

- 先頭車の前後(+Z面)がゲーム内で実際にどちらを向くかは目視未確認。違和感があれば
  `--flip` を付けて再生成すること。
- SAHA(サハ)は変換対象外。`car_tail`専用形状が必要になった場合はSAHA用のCLI引数を追加する。
