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
