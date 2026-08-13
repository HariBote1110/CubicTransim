# 列車外観エディタ Phase B: ワンオフ編集ツール

## 決定
- 列車外観エディタ計画Phase A(`progress/train-parts-spec.md`)で作った宣言的パーツスペック
  (`TrainPart[]`)を、実際にGUIで編集・プレビューできるワンオフツールを追加した。ゲーム本体
  への統合(セーブへの反映・実行時の見た目差し替え)は目的外で、`MODEL_PARTS`
  (`render/trainMeshBuilder.ts`)を手で更新するための下書き用途に限定する。
- エントリは `train-editor.html`(Vite の第2エントリ、開発URLは
  `http://localhost:5175/train-editor.html`)。`src/tools/trainEditor/` 配下に
  独立したReactアプリを置き、`src/components`・`src/hooks`・`src/App.tsx` には依存しない
  (`render/**` と `sim/physics` の型・純関数のみ再利用)。ゲーム本体バンドル(`main`)には
  影響しない。
- プレビューはゲーム本体と同じ `WebGpuTerrainLayerController`(`render/webgpuLayer.ts`)を
  直接インスタンス化して使う(`src/tools/trainEditor/previewController.ts`)。flat
  プロファイル・halfExtent=8 の小さな地形の上に、head→mid→tail(headを180°流用)の
  3両編成をインスタンス描画で表示する。パーツ編集は100msデバウンスで
  `registerInstancedMesh` に再登録し、カメラ操作(ズーム/パン/編成全体のyaw回転)は
  毎フレーム `setInstances`/`syncAndRender` に反映する(クォータービュー固定のため、
  「回転して側面を見る」操作は編成のインスタンス位置とyawの両方をY軸回転させて実現する)。
- エディタUIは車種選択(4種、`TRAIN_MODELS`の日本語名)→head/midタブ→パーツ一覧
  (表示切替・複製・削除・並べ替え)→選択パーツのインスペクタ(kind/size/pos/rot(度)/
  colour/tint)という構成。`validateParts`(表示中パーツのみ)の警告をリアルタイム表示する。
  JSON入出力は「コピー」「書き出し(ダウンロード)」「貼り付けて適用」のみで、
  ソースコードへの自動書き込みは行わない。

## 運用
- エクスポートしたJSON(`<model>.json`)を `render/trainMeshBuilder.ts` の
  `MODEL_PARTS[model]` へ手動で貼り込む。エディタ側は保存状態を持たない(ページを閉じると
  編集内容は消える)。

## 制約・注意点
- 永続化・元に戻す(undo)機能は無い。モデル切り替えは編集中のドキュメントを破棄して
  `MODEL_PARTS` から作り直す。
- WebGPU非対応環境では `webgpuLayer.ts` の `UNAVAILABLE_MESSAGE` をそのまま流用した
  案内を表示する(ゲーム本体と同じ文言)。

## マウス操作一覧(0.5.0-Alpha-24a)
- **左ドラッグ(空地)**: パン。カーソル下の地表点(y=0)が動かないよう、`picking.ts`の
  `screenPxToGround`と同じ逆変換でcentreX/centreZをずらす。
- **左クリック/ドラッグ(パーツ上)**: パーツを選択し、そのままドラッグで地面平面上を
  移動する(ワールド移動量を掴んだ車体のyawで逆回転し、パーツのローカルx/zへ変換するので
  yawが付いていてもカーソルに追従する)。0.01単位でスナップ(Altキーで0.001単位)。
  パーツ一覧の選択行とも双方向に同期する。
- **Shift+左ドラッグ(パーツ上)**: 選択パーツのローカルYのみを動かす(スクリーンy方向の
  移動量をISO_Hで割り戻す)。
- **右ドラッグ/中ドラッグ**: 編成全体のyaw回転(横方向の移動量×0.4°/px)。
- **ホイール**: ズーム(60〜600px/uにクランプ)。画面中心基準(カーソル追従ではない)。
- **矢印キー**: 選択パーツをローカルx/z方向へ0.01ずつナッジ。**PageUp/PageDown**:
  ローカルy。**Delete/Backspace**: 選択パーツを削除。フォーカスがinput/textarea中は無効。
- クリック位置のパーツピッキングは `partPicking.ts` が担う。パーツのローカルAABB
  (`trainPartsSpec.ts`の`partBounds`)の8頂点を車体のyaw+位置でワールド変換し、
  `webgpuCamera.ts`の`projectToScreenPx`(描画本体と同じ投影式)でスクリーンへ射影して
  外接矩形をヒットテストする。複数パーツが重なった場合は、ヒットしたスクリーン空間AABBの
  面積が最小の候補を選ぶ(重なりの中で一番「的が小さい」ものはクリックの意図に近いという
  簡易近似。三国投影は厳密な深度情報を持たないため、正確なz-orderの代わりに採用)。
- 選択パーツは`buildCarMeshFromParts`の`highlightIndex`引数(エディタ専用の追加パラメータ、
  ゲーム本体の呼び出しには影響しない)でハイライト色(`#ff2e63`)へ焼き替えて描画する。
  ただし`tint: true`のパーツ(路線色で塗り替わる帯など)はインスタンス描画のalphaが
  「tintを掛ける重み」を兼ねる規約のため、ハイライト色より路線色が優先されて見える
  (既知の制約。alphaを不透明度として使い回すとバグる—別記のground-height修正時に一度
  誤用して気付いた)。
- 編成(head/tail/mid)の3インスタンスの座標変換は`consistLayout.ts`の`consistTransforms`に
  一本化した(`previewController.ts`の描画と`partPicking.ts`のピッキングが同じ式を共有)。
  地表(y=0)に対する車体origin高さは`GROUND_SURFACE_Y = 0.5`固定(ゲーム本体で
  `carGroupPosition`が`RAIL_SUPPORT_OFFSET`ぶん持ち上げた、平坦な線路上のrenderPos.yと
  同じ値。エディタは常に平坦プロファイルなので、地形の実測ではなくこの定数で済ませている)。
