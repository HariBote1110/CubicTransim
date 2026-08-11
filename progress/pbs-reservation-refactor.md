# PBS(経路予約ベース)運行モデルへのリファクタリング (v0.2.0-Alpha-1a)

## Decision
- `progress/openttd-source-notes.md` / `progress/openttd-inspired-train-behaviour.md` の設計に沿って、フェーズ1「経路予約の一級市民化」を実施した。
- 新規 `src/sim/reservation.ts`: セル単位(1セル1列車)の排他予約テーブル(`tryReserve`/`releaseCell`/`releaseAllOf`/`forceAssign`)と、safe waiting point判定(`isSafeWaitingPoint`)・経路中の最初の安全点探索(`findSafeSegmentEnd`)を実装。
- `src/sim/simulation.ts`のstepTrainを、safe waiting pointまでの区間予約(`ensureReservation`)を軸にした走行モデルへ全面置換した。

## 削除したもの
- `computeObstacleDistance`内の信号コンフリクト判定ヒューリスティック一式:
  - 対向列車のtrail/routeを個別にスキャンして衝突可能性を判定するロジック
  - 進行方向の内積(`dot(myDir, otherDir) > 0.5`)による「同方向なら衝突とみなさない」判定
  - `train.id < other.id`による「場当たり的な優先順位」判定(先着デッドロック回避のためのid比較)
  - 信号コンフリクトの見通し区間を「次の分岐点/信号セルの手前まで」に限定する`isSectionBoundary`
- `buildRouteSets`(他列車のtrail=occupied、route=reservedを別々に集める関数)。予約テーブルが占有と予約を統合した単一の情報源になったため、`buildBlockedSet`(予約テーブルから自分以外の予約セル集合を1つ作るだけ)に置き換えた。

## 何に置き換えたか
- **予約の取得・延長 (`ensureReservation`)**: 列車は常に「現在位置から次のsafe waiting pointまで」の区間を`tryReserve`で予約してから走行する。予約末端までの残り距離が現在速度での制動距離+マージン(`BRAKING_MARGIN_M`)以内に近づいたら、次の安全点までの延長を試みる。失敗時は現状維持(=末端で待機、毎tick再試行)。
- **減速目標の一本化**: 駅到着も信号待ちも「予約(`reservedEndIndex`)がそこまでしか無い」という同じ扱いになった。`reservedEndIndex`が経路末尾(=目的駅の停止セル)に達していれば`obstacleType: 'station'`(最低速度保証あり)、途中の安全点なら`'signal'`相当(速度0まで許容)として速度制御する。
- **予約の解放**: trailから後端セルが抜けた瞬間(`pushArrivedGrid`)にそのセルの予約を即時解放する。反転(終端駅での瞬時折り返し)は、既存の設計上「経路を完全に消化した(`route.length===0`)直後」にしか発生しないため、追加の解放処理なしで前方予約の残留は起きない。
- **pathfinding.tsのシグネチャは変更していない**(occupied/reservedの2引数のまま)。呼び出し側(simulation.ts)で両方に同じ`buildBlockedSet`の結果を渡すことで、実質的に「他列車の予約セル集合1本」に統合した。テスト16件を書き換えずに済ませるための意図的な選択。

## safe waiting pointの判定ルールとテスト駆動での修正
当初は設計文書の記述通り「分岐点(接続3方向以上)そのもの、および分岐点の直前は安全ではない」を厳密に実装したが、既存の`passing-loop.test.ts`(信号2個だけの単純な交換設備)で**恒久デッドロック**が発生することが判明した:
- 交換設備の分岐点(本線・待避線の合流点)の直前セルが同時に信号セルの直前でもある特殊な配置だったため、「分岐点直前は不可」ルールにより経路上に安全点が一切見つからず、両列車とも「起点から目的駅(相手の停車セル を含む)までの経路全体」を1回の予約で確保しようとして相互に相手の停車セルを含む区間を要求し、恒久的にデッドロックした。
- 対策として、safe waiting pointの判定を以下の優先順位に変更した(`isSafeWaitingPoint`):
  1. 次セルが信号セルなら、自セルが分岐点であっても安全(信号がその先を防護している)
  2. 分岐点そのものは安全ではない(停止しない)
  3. 車庫・駅セルは安全
  4. 次セルが無い(行き止まり)なら安全
  5. **次セルが分岐点なら安全**(分岐点そのものには進入・停止しないが、その手前では停止できる。区間を細分化することで、対向列車と予約区間が分岐点を跨いで丸ごと衝突するのを防ぐ)
  6. それ以外は不可
- この5番目のルールにより、分岐点2つ(交換設備の両端)がそれぞれ独立した区間境界として機能し、対向列車が互いに相手の必要区間(相手の停車セルを含む全区間)を要求せずに済むようになった。

## シナリオテスト
- 既存`passing-loop.test.ts`(交換設備すれ違い・純単線の頑健性)は新モデルで無修正のままパス
- 新規`src/sim/pbs-reservation-scenarios.test.ts`:
  - 双方向1本ホーム(行き止まりでない共有駅セル)への対向2列車: 片方が手前で待ち、順に使用、衝突・デッドロックなし
  - 予約の解放: trailから抜けたセルが予約テーブルから即時削除され、他列車が予約可能になることを確認
  - 分岐の直前で待たない: 走行中に速度0で待機している列車の現在地が、分岐点セルそのものになっていないことをシナリオ全体で検証
- `src/sim/reservation.test.ts`: 予約テーブルの基本操作(取得/部分失敗時のロールバック/解放)とsafe waiting point判定の単体テスト

## stepWorldの2パス化
同一tick内で、まだ自分のtrailセルを予約テーブルへ登録していない列車(特に停車中の列車)の位置を、先に処理される列車が「誰も予約していないセル」と誤認して奪ってしまう競合が発生したため、`stepWorld`のrunning列車ループを2パスに分離した: 先に全running列車の`ensureRuntime`(trailの予約bootstrap)を済ませてから、経路計算・走行処理を行う。

## セーブデータ互換性
- 予約状態(`reservations`)はセーブデータに含めない(`SimWorld.reservations`は非永続フィールド)。SaveData形式はv7のまま変更なし。
- ロード直後は予約テーブルが空の状態から始まるが、`ensureRuntime`が各列車のtrailセルを検出して予約テーブルへ再登録し(`TrainRuntime.reservedEndIndex`もv7以前のセーブでは存在しないため`persistence.ts`のデシリアライズ時に`-1`で補う)、最初の`stepWorld`呼び出しで走行中の経路予約が自然に再構築される設計とした。

## バージョン
- `0.1.0-Alpha-9b` → `0.2.0-Alpha-1a`(アーキテクチャ刷新のためminorを繰り上げ)
