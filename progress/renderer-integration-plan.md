# WebGPUレンダラーの本体統合計画

## Decision

プロトタイプ(層A・層B全合格、progress/quarterview-renderer-spec.md)を本体へ段階統合する。
方針は**ハイブリッド合成から始める漸進置換**: 一括置換はリスクが大きすぎるため、
「wgpu が地形(最重量部)を描き、three.js が透過キャンバスで上に動的物を描く」二層構成で
まず価値(全図ズームアウト)を出し、その後 three.js 側の担当物を段階的に wgpu へ移す。

1. **昇格**: renderer/ の crate 群を `renderer/`(リポジトリ直下、Cargoワークスペース)へ
   移動・整理する(research からの昇格。ベンチ(layer_a/layer_b ハーネス)も一緒に移し、
   回帰ゲートとして維持)。wasm-pack ビルドを npm scripts に統合(`npm run build:renderer`)
2. **二層合成**: ゲーム画面は「下層 = wgpu キャンバス(地形・水面)/上層 = three.js キャンバス
   (透過背景、レール・列車・駅・町・木・プレビュー等の既存描画)」。カメラは既存
   OrbitControls が真実源で、毎フレーム wgpu 側へ (target, zoom) を送る(wasm に
   set_camera API を追加)。座標系・投影の一致はピクセル単位で検証する(同一セルの
   地形角とレール位置のスクリーンショット比較)
3. **切替**: 設定パネルに「レンダラー: WebGPU / 従来」トグル。WebGPU 非対応環境は自動で
   従来へフォールバック(navigator.gpu 検出)。両立期間中、既存 TerrainBlocks は
   WebGPU モード時のみアンマウント
4. **編集差分**: cornerDiffs の変更を wasm へ疎転送(チャンク単位)し、該当タイルを再生成。
   terraform の反映 ≤1フレーム(T8 相当をここで初めて実測)
5. **ズームアウト解禁**: WebGPU モード時のみ minZoom を全図まで開放。遠ズームでは
   three.js 上層を段階フェードアウト(まず全消し。町ドット等の遠景表現は次フェーズ)
6. **地下・高架ビュー**: 当面 three.js 上層の担当のまま(wgpu は地表のみ)。地下ビュー時の
   地表減光は wgpu 側に dim uniform を追加して同調させる

## フェーズ

- R1: 昇格+ビルド統合+二層合成+カメラ同期+設定トグル(地形が wgpu で出る、見た目一致検証)
- R2: cornerDiffs 転送と地形編集の同期(T8実測)、地下ビュー減光の同調
- R3: ズームアウト解禁+遠景仕上げ(上層フェード、town ドット表現は wgpu 側に実装)
- R4以降: 木・町タイルのインスタンシング移管 → レール/列車 → three.js 退役判断

## Alternatives considered

- **一括置換(three.js 全退役してから統合)**: 棄却。レール・列車・UI装飾まで wgpu に
  揃うまで数週間ユーザー価値が出ず、差分も巨大化する
- **wgpu を three.js の外部テクスチャとして合成**: 棄却。キャンバス重ね合わせの方が単純で、
  ブラウザのコンポジタが十分速い

## Constraints / Gotchas

- 2キャンバスのDPR・リサイズ同期を最初に固めること(ズレの温床)
- three.js 側の地面プレーン(picking)は WebGPU モードでも維持(colorWrite:false の既存機構を流用)
- Electron での WebGPU 動作確認は R1 の完了条件に含める
- 影: wgpu 地形には three.js の影が落ちない。両立期間中は割り切る(記録済みの既知差異とする)
