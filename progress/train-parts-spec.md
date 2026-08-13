# 列車外観エディタ計画 Phase A: 宣言的パーツスペック

## 決定
- 車種ごとの列車外観は `render/trainMeshBuilder.ts` の手続き的な `box()` 呼び出し列
  (旧 `buildCarEntries`)ではなく、`render/trainPartsSpec.ts` の `TrainPart`(プレーンデータ、
  JSON往復可能)配列として持つよう変更した。
- `TrainPart.kind` は `box` / `wedge` / `cylinder` / `cone` の4種。`size` の意味は kind ごとに
  異なる(cylinder/coneは `[radiusTop/radius, height, radiusBottom]`)。`rot` はオイラー角
  (ラジアン)で X→Y→Z の順に適用してから `pos` を加える。
- `buildPartGeometry(part)` が純関数としてジオメトリを組む。`validateParts(parts)` はパーツ
  配列全体のAABBを寸法制約(全長<=0.92・全幅<=0.50・全高|y|<=0.60)と照合し、日本語の警告文
  配列を返す(空 = 問題なし)。個々のパーツではなく組み立て後のAABBで判定する(台車・床下機器は
  意図的にy<0へはみ出すため、パーツ単体の「y>=0」制約は課していない)。
- `wedge` は「後端(Z=-depth/2)が幅×高さの矩形断面、前端(Z=+depth/2)が同じ幅のまま上下が
  1本のエッジに収束する」形状。上面1枚が後端の上端から前端の低いエッジへ傾斜する。これにより
  流線形ノーズ(express/local-express)を旧来の「2段Boxの近似」ではなく1パーツで表現できる。
  dir=-1側(反対の妻面)は `rot=[0,Math.PI,0]` でローカル+Z(低いエッジ側)をワールド-Zへ向ける。
- `render/trainMeshBuilder.ts` の `MODEL_PARTS: Record<TrainModelId, TrainCarParts>` が
  4車種×head/mid ぶんの `TrainPart[]` を保持する(モジュール読み込み時に一度だけ構築)。
  `buildTrainCarMesh(variant, modelId)` は `MODEL_PARTS[modelId][variant]` を
  `buildCarMeshFromParts` に渡すだけの薄いラッパーになった。tint(路線色)/焼き込み色の規約
  (`alpha: part.tint ? 255 : 0, unlit: true`)は従来どおり。

## Phase Bへの引き継ぎ
- `MODEL_PARTS` はエディタ(未実装)がそのまま読み書きできるプレーンデータ。エディタ側は
  `buildPartGeometry`/`buildCarMeshFromParts`/`validateParts` をプレビュー・保存前検査に
  再利用できる。本フェーズではUI・永続化(セーブへの反映)は未着手。

## 制約・注意点
- `wedge` は幅方向(X)を一定に保ち、高さ(Y)のみを後端→前端で傾斜させる設計。左右にもすぼめたい
  見た目が必要なら、複数の box/wedge を組み合わせる(1パーツでは表現しない)。
- `MODEL_PARTS` を JSON.parse(JSON.stringify(...)) で往復させても `buildCarMeshFromParts` の
  出力(頂点位置・頂点色)が変わらないことをテストで固定済み(`trainMeshBuilder.test.ts`)。
