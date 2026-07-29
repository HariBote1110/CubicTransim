# OpenTTD風の段丘状標高地形

## Decision
- 標高はセーブ形式に含めず、既存の`terrain: Map<string,'water'|'mountain'>`から`computeElevation`で毎回決定的に導出する方式にした。永続化フォーマットを変えずに済み、mountain判定の意味(トンネル建設対象など)も不変。
- 標高値 = mountainセルから最も近い非mountainセルまでのマンハッタン距離を多始点BFSで計算し、`MOUNTAIN_ELEVATION_MAX=3`でクランプ。O(セル数)。
- 1段の高さは`sim/trackPath.ts`の`OVERPASS_HEIGHT(0.8)`に合わせた。将来の高架・トンネルとの視覚整合のため。
- 山脈生成の幅を`MOUNTAIN_WIDTH_MIN=3〜MAX=6`に拡張(旧1〜2)。標高2〜3の芯ができる幅を確保。
- 描画(`TerrainBlocks.tsx`)は「側面=BoxGeometryの柱(既存rock/rockDark流用)」+「上面=薄い板(標高1〜2は`grassTerrace`、標高3は`rockSnow`)」の2ジオメトリ重ねに刷新。旧・八面体の岩塊装飾(OctahedronGeometry)は廃止。

## Alternatives considered
- 標高をセーブデータに直接持たせる案 → 却下。既存セーブとの互換性を壊し、mountain判定と標高の二重管理になる。
- 3x3塊の中心標高を距離1にする単純化 → 実装時に誤りと判明(実際のBFSでは中心は距離2)。テストを実際のマンハッタン距離ベースの値に修正。

## Constraints / Gotchas
- BFSは「非mountainに隣接するmountainセル」を境界(距離1)として初期化し、そこから多段階に伝播する。距離がMAXを超えても訪問は続け、値だけクランプする(そうしないと芯の far セルが未訪問=標高0のままになるバグを踏む)。
- `tunnelKeys`(トンネル化済みセル)は従来通り描画をスキップする挙動を維持。標高の刷新後もこの分岐は変更していない。
- `MATERIALS.rockSnow`と`MATERIALS.grassTerrace`を`render/palette.ts`に新設。既存の`PALETTE.rockSnow`/`PALETTE.grassDark`を流用。

## 追記(v0.3.0-Alpha-29a: 垂直段丘→斜面つきメッシュへ刷新)
- ユーザーから「山の側面が垂直のボックス段丘で『マイクラのよう』」との指摘。OpenTTD本家は隣接セルの標高差を斜面(4隅コーナーの高さが個別に変化する四角形)で繋ぐため、それに寄せた。
- `sim/terrain.ts`に`cornerElevation(elev,cx,cz)`(コーナー(cx,cz)=世界座標(cx-0.5,cz-0.5)を囲む4セルの標高のmin)と`cellCornerElevations(elev,x,z,cliffFaces?)`(セルの4隅[左上,右上,右下,左下]をこの規則で返す)を追加。min則は距離関数(computeElevationのベース)が1-Lipschitzであることに由来し、隣接セル間のコーナー標高差は常に1以下になる(=面が必ず連続する)ことをテストで担保。
- `TerrainBlocks.tsx`はBoxGeometryの段丘をやめ、セルごとに「4隅コーナー標高を頂点に持つ四角形を2三角形に分割した上面」+「4隅の最小標高ぶんの柱(側面)」の組み合わせに変更。対角線分割は「高さが等しい2隅を結ぶ側」を優先(ひねりの少ない見た目)。上面材質(草/雪)の判定はセル自身の標高のままで、隣接セルとのコーナー共有だけで斜面ができる。
- トンネル坑口面(cliffFaces、`GameScene.tsx`で`tunnelPortals`から`"x,z,dx,dz"`集合を作って渡す)だけは例外的に、その面の2隅をmin則ではなくセル自身の標高に固定し、垂直の崖として残す。持ち上げた分の隙間は別途壁クアッド(岩色)で埋める。
- `MATERIALS.grassTerrace`に`flatShading:true`を追加(斜面ファセットがOpenTTD風にはっきり見えるように)。マージ後のジオメトリには`computeVertexNormals()`を呼ぶ(非indexなので面法線=頂点法線になりflatShadingと整合)。

## 追記(v0.3.0-Alpha-29d: 上面三角形の巻き順が裏面向きだった不具合を修正)
- 上面三角形の頂点順(`tl,tr,br`等)が+Yから見て時計回りになっており、法線が下向き(裏面カリングで上面が非表示)になっていた。地面へ落ちた影だけが見えて「地形が透けてトンネル内部が見える」ように見えていた根本原因。
- 頂点順の最後2つを入れ替えてCCW(法線+Y)に修正。cliffFacesの壁クアッド(`pushQuad(top0,top1,bottom1,bottom0)`)は法線計算で確認した結果、既に外向きCCWで正しかったため変更なし。
- あわせて`sim/tunnel.ts`の`tunnelPortals`に`elevation`引数を追加し、行き止まり坑口(接続1方向のセルの反対方向)は反対方向の隣接セルがmountainでない(標高0)場合だけ作るよう修正(山の内部に坑口が立たないように)。`GameScene.tsx`は`computeElevation`の結果を渡す。
- `cellCornerElevations`のcliffFacesによる持ち上げを`CLIFF_LIFT_MAX=1`段までに制限(自然標高の方が高ければそちらを優先、`Math.max`)。

## 追記(v0.3.0-Alpha-30a: 共有コーナーマップ化・斜面フリンジへの建設制限)
- cliffFacesを宣言したセル単位で`cellCornerElevations`を個別計算すると、同じコーナーを共有する隣接セル(cliffFaces非宣言側)からは持ち上げ結果が見えず、上面メッシュに裂け目ができてトンネル内部が透けて見えていた。`buildCornerElevationMap(elev, cliffFaces)`(コーナー座標→標高の共有マップ、cliffFacesの持ち上げをコーナー単位で一度だけ適用)を新設し、`TerrainBlocks.tsx`は1度だけ構築したマップを`cellCornersFromMap`で読む形に変更。`cellCornerElevations`(旧API)は内部的にこの2つの組み合わせとして再実装し、戻り値の互換性は維持。
- GameSceneの坑口の黒開口ボックスをトンネル奥行き方向(ローカル-Z、山の内側)へ深く(1.0)伸ばし、開口の向こうにトンネル内部のレールが透けて見える問題を解消。
- 天井が完全に覆われていない山岳セル(自然コーナー標高の4隅のいずれかが0、斜面フリンジ)にレールを敷くと、レールが山肌から突き出して見えていた。`construction.ts`に`pathHasUnsupportedMountainCell`を追加し、山岳セルへの敷設を「坑口セルになる(経路上の接続方向、または行き止まりならその反対方向に非mountainが隣接)」か「天井が完全に覆われた内部セル(自然コーナー標高が4隅とも1以上)」のどちらかに制限。違反する経路はno-op。
- 「垂直な緑の大壁(2〜3段)」の報告について調査したが、現行コードでは再現できなかった。数学的に、坑口セル(=非mountain隣接、computeElevationの定義上必ず標高1)のコーナー標高はCLIFF_LIFT_MAX=1で頭打ちになり、天然の斜面(cliffFaces非関与)も「高さが等しい2隅を結ぶ対角線を優先する」ヒューリスティックにより、実際の生成地形(複数シード)・意図的に作った凹型の地形いずれでも三角形の1辺あたりの高低差は1段(0.8)を超えないことを確認した。CLIFF_LIFT_MAXの導入・行き止まり坑口の修正(いずれも本バージョンより前のコミットで導入済み)以前のスクリーンショットである可能性が高いと考えられる。再現する場合は生成シード・該当セル座標つきで再報告してほしい。
