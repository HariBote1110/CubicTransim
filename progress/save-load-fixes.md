# セーブ／ロードの不具合修正(0.5.0-Alpha-26a)

## 決定事項
- `useGameLogic.ts` の `loadGame()` が `RestoredWorld.halfExtent` を `setHalfExtent` せず捨てていたバグを修正。マップサイズが違うセーブを読み込むと地形・町が「新規ゲームで選んだサイズ」のまま再生成され、線路・駅の座標系とズレて世界が壊れる不具合だった。`RestoredWorld` の他フィールド(seed/cornerDiffs/townDensity/terrainProfile/rules等)は既に全て復元済みだったことをフィールド単位で突き合わせて確認済み。
- `loadGame`/`saveGame` の共通適用ロジックを `applyRestoredWorld()` として抽出(スタートアップダイアログからの直接ロードでも同じ処理を使うため)。
- `saveGame()` に try/catch を追加。`localStorage.setItem` はクォータ超過(2048〜8192セルの大マップでJSONが5MB超になりうる)で例外を投げるが、従来は捕捉されず「セーブしたつもりが実は失敗」の無言バグだった。成功/失敗をトースト通知でユーザーに明示する。
- `loadGame()` の `JSON.parse` を try/catch で保護し、旧バージョン/破損セーブ(`deserialiseWorld`がnullを返すケースを含む)でもトーストで日本語のエラーを出すよう変更(従来は`console.warn`のみで無反応に見えた)。
- 起動時のマップサイズ選択ダイアログに「セーブデータから再開」ボタンを追加(`localStorage`にセーブが存在する場合のみ表示)。押すと`loadGame()`を呼んでからダイアログを閉じる。`loadGame`が復元する`halfExtent`/`seed`はダイアログの選択値より必ず後勝ちする(ダイアログの選択肢はそもそも参照しない)。

## 実装
- トースト通知: 専用コンポーネントは無かったため、`useGameLogic`に`toast: ToastNotice | null`state(3秒で自動消去)を追加し、`App.tsx`側で画面下部に固定表示する最小限の実装を追加(`src/ui/theme.ts`のトークンを使用)。

## 検証
- `npm run build`(tsc + vite build)は成功。
- `npm run test`は1272件中1271件成功。唯一の失敗(`towns.test.ts`の16K・packed性能ガード、1.5秒閾値に対し1795ms)は本修正と無関係な既存のマシン負荷依存テストで、単体再実行では1.51秒台で成功することを確認済み。
- `loadGame`のhalfExtent復元は`useGameLogic`フックの統合テストが存在しないため、ユニットテストでは検証できていない。回帰は手動でのブラウザ検証(大きいマップでセーブ→小さいマップで新規ゲーム→セーブから再開→halfExtentが復元される)を推奨。
