# 列車インスタンス描画: フラグメントシェーダ陰影への切替(0.5.0-Alpha-16a)

## 背景・不具合

坂の上を走る列車の描画に2つの不具合があった。

1. **2両目(tail車両)の傾きが逆**: `WebGpuTrains.tsx`はtail車両を`finalYaw = yaw + Math.PI`
   だけで表現していたが、`mesh_instanced.wgsl`の回転順(ピッチ→ヨー)ではyawのπ反転は
   forwardベクトルのx/z成分だけを反転しz、pitch由来のy成分は反転しない。結果、坂で
   tail車両が実際の進行方向と逆に傾いて見えた。
2. **陰影が回転に追従しない**: `bakedMesh.ts`の`bakeFlatShaded`は固定太陽方向
   `SUN_DIRECTION=normalize(-30,34,14)`のランバート陰影をジオメトリ生成時に頂点色へ
   焼き込む方式。地形・静的メッシュチャンクはインスタンス回転が無いので問題ないが、
   列車はインスタンスごとにyaw/pitchで回転するため、焼き込んだ陰影が回転前の姿勢に
   固定されたまま(坂や(1)のtail反転ピッチで特に破綻して見える)。

## 決定

### 不具合1: tail車両のpitch反転

`WebGpuTrains.tsx`で`finalPitch = isTail ? -pitch : pitch`を追加。

回転行列を手計算で検証: forward = (cos(pitch)sin(yaw), -sin(pitch), cos(pitch)cos(yaw))。
yaw→yaw+π かつ pitch→-pitch にすると x/z 成分は符号反転(-sin(yaw)/-cos(yaw)の分)、
y成分も `-sin(-pitch) = sin(pitch) = -(-sin(pitch))` で符号反転し、3成分とも
`-heading`と一致する。yawだけ反転する旧実装はy成分が反転せず誤っていた。
`trainInstanceMath.test.ts`にこの回転再現を検証するテストを追加した。

### 不具合2: フラグメントシェーダでの陰影計算

列車(インスタンス描画)専用に、TS側の焼き込みをやめてWGSL側で毎フレーム計算する方式へ
切り替えた。

- `bakedMesh.ts`の`BakeOptions`に`unlit?: boolean`を追加。trueならランバート係数を
  掛けず基本色をそのまま頂点色にする(alphaのtint重み規約は無変更)。地形・静的メッシュ
  チャンクは既定値(false)のままで焼き込み陰影を維持し、ゴールデン値への影響は無い。
- `trainMeshBuilder.ts`(プレースホルダ車体・選択マーカー・経路ドット)と
  `trainModelLoader.ts`(.glbモデル)の両方で`unlit: true`を指定。インスタンス描画
  パイプライン(`MESH_ID_HEAD`/`MID`/`SELECTION`/`ROUTE_DOT`)を通るメッシュは全て
  unlitに揃えないと、選択マーカーや経路ドットがシェーダ側の陰影と二重掛けで暗くなる。
- `mesh_instanced.wgsl`: 頂点シェーダで回転後のワールド座標を`world_pos`として
  varying へ渡し、フラグメントシェーダで`dpdx`/`dpdy`から面法線を
  `normalize(cross(dpdy(p), dpdx(p)))`で求め、`bakedMesh.ts`の`lambertFactor`と
  同じ式(AMBIENT_TERM=0.2, HEMISPHERE_TERM=0.28×(0.5+0.5*normal.y),
  SUN_TERM=0.55×max(0,dot(normal,sun)))・同じ太陽方向(`normalize(-30,34,14)`を
  WGSL側で定数として埋め込み)で明るさを掛ける。微分命令はWGSLの制約により
  非一様分岐の外(fs_main先頭)で無条件に呼んでいる。
  法線の向き(`cross(dpdy,dpdx)`か`cross(dpdx,dpdy)`か)は符号の取り違えやすい箇所
  なので、ブラウザ実機で屋根面が側面より明るく見える組み合わせを選んだ。

## 代替案として却下したもの

- **頂点シェーダで法線を持たせる**: プロトタイプメッシュは非indexedの三角形スープで
  法線バッファを持たないため、頂点属性を追加するとメッシュ登録・バッファレイアウトの
  変更が必要になり影響範囲が広い。screen-space微分ならワールド座標のvaryingだけで
  済むため採用しなかった。
- **列車も含め全メッシュを毎フレーム計算に統一**: 地形・静的メッシュチャンクは
  回転しないので焼き込み陰影のままで十分正確であり、変更するメリットが無い上に
  golden値のあるテストへ影響するため見送った。

## 制約・注意点

- `unlit`はインスタンス描画パイプラインを通るメッシュ専用のフラグ。新しくインスタンス
  メッシュを追加する場合は`unlit: true`を付け忘れないこと(付け忘れると焼き込み陰影+
  シェーダ陰影の二重掛けで暗くなる)。
- screen-space微分はポリゴン境界(異なる三角形の隣接ピクセル)で不正確になりうるが、
  ローポリの列車モデルでは面ごとの陰影差が目視で分かれば十分という前提。
