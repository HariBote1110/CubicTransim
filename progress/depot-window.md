# 車庫インスペクタ(spawn-on-click廃止)

## 決定
- 車庫セルをクリックすると即購入して列車が湧く旧仕様(GameScene.tsxのonBuyTrain即時呼び出し)を廃止した。
  クリックは選択のみ(`selectDepotKey` = `toKey(x,z)`、列車選択・駅選択と排他)にし、実際の購入・出庫・売却は
  GameUI.tsxの新規`DepotInspector`パネル(TrainInspector/StationInspectorと同じ並びの左上パネル)で行う。
- `DepotInspector`は在籍列車一覧(`status === 'stored' && t.x/z === depot`)に「選択」「出庫」「売却」ボタンを
  出し、下部に動力方式(rules.electrification!=='none'のみ)・保安装置(rules.signalling==='s3'のみ)の
  ピッカーと価格表示付きの購入ボタンを持つ。購入後もパネルは開いたまま(自動選択・自動クローズはしない)。
  動力/保安装置の選択状態は`DepotInspector`のローカルstate(選択車庫が変わってもリセットされないが、
  車庫ごとに独立ではない単一値。実用上は購入直後に続けて同じ設定で買い足すユースケースを想定した割り切り)。
- 売却の払い戻しは`sim/economy.ts`の`trainSellRefund(baseCost, cars)`(新規、TDD)。CAR_REFUND/CAR_COSTと
  同じ50%比率を編成全体(基準2両分の価格+超過ぶんをCAR_COST換算で加算)に適用する。台帳への計上は
  `removeCar`と同じ形(`construction`へマイナス計上)。
- 旧ツールバーの車庫購入ピッカー(GameUI.tsx buildMode==='depot'の動力/保安装置選択、およびApp.tsxの
  `purchasePower`/`purchaseProtection` state)は完全に削除し、選択状態はDepotInspector内に閉じ込めた。
  車庫(depot)ツールは「車庫を置くだけ」のツールに戻り、ヒント文言も
  「選択ツールで車庫をクリックすると車両の購入・管理ができる」に変更した。
- `buyTrain`(useGameLogic.ts)から`setSelectedTrainId(newTrain.id)`の副作用を削除した。購入しても
  自動で列車インスペクタへは切り替わらない(車庫パネルに留まる)。

## 代替案として検討したが不採用
- 車庫ごとに購入設定(動力/保安装置)を独立保持する案 → 状態管理が増える割に効果が薄いため見送り、
  DepotInspector単一ローカルstateに単純化した。

## フォローアップ(未実装)
- 運行中の列車を車庫へ戻す(入庫/回送)操作は本対応のスコープ外。将来的にGameScene/useGameLogicへ
  「最寄りの車庫へ回送」的な指示を追加する余地がある。
