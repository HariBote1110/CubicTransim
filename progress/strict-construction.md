# 建設厳格化(駅方向指定・ドラッグ駅・車庫自動接続・自動整地)

## 概要

「なんとなく建つ/なんとなく繋がる」を減らし、プレイヤーの意図と建設結果を一致させる
バッチ。BuildFailureReasonによる理由表示の一本化を土台に、駅の方向をプレイヤーの明示
選択として権威化し、車庫の自動接続を単一出入口に限定し、地上レールのother斜面だけを
救済する自動整地(埋め立て)を足した。

## 決定1: BuildFailureReasonで建設失敗理由を一貫して返す

### 決定
- `applyStationDetailed`/`applyDepotDetailed`/`applySubstationDetailed`/
  `applySignalDetailed`/`applyRailPathDetailed` が `{state, failure}` の形で失敗理由を
  返すようにし(`BuildFailureReason`型、`src/sim/construction.ts`)、`buildPreview.ts`の
  `BuildPreview.failure`へそのまま伝える。UI(BuildFeedback)は理由ごとに日本語文言を出す。
- 理由は用途別に分かれている: `water`/`not-flat`(立地条件、駅・車庫・変電所・信号共通)、
  `town-tile`/`house-tile`(町タイル、後者は地平線路専用で道路の踏切通過とは区別)、
  `occupied`、`ramp-conflict`、`needs-adjacent-electrified-rail`、`needs-rail`、
  `station-axis-mismatch`、`GroundRailPlanFailureReason`各値(`other-slope`/
  `direction-blocked`/`edge-discontinuous`/`tunnel-exit-mismatch`)。

### 代替案として却下したもの
- 「一律`no-effect`のまま、UI側で状況から理由を推測する」— 呼び出し元(UI)は建設不可の
  原因を厳密には特定できず(no-opの同一参照だけでは水域なのか駅重複なのか区別不能)、
  誤った案内文になりうるため却下。理由はapply系が判定した時点で確定させ、そのまま運ぶ。

## 決定2: 駅の建設方向(南北/東西)をプレイヤーの明示選択にする

### 決定
- ツールバーに南北/東西のトグルを追加し、`StationAxis`(`'ns' | 'ew' | 'cross'`)を
  `applyStationDetailed`/`applyStationPathDetailed`へ明示的に渡す。
- 渡された`axis`が`'ns'`/`'ew'`のときだけ`stationAxisConflict`(`construction.ts`)で
  隣接する**線路(rail)セルのみ**との矛盾を判定し、矛盾していれば
  `'station-axis-mismatch'`(「線路の向きと合いません」)で拒否する。判定対象を線路
  セルに絞るのは、隣接する既存駅セルとの通常の併合・十字乗換駅の形成を妨げないため。
  - 軸方向の隣接線路が駅へ戻る接続ビットを持たない(=折れている)→ 矛盾
  - 直交方向の隣接線路が駅へ戻る接続ビットを持つ(=側面食い込み)→ 矛盾
- 矛盾がなければ、`axis`をそのまま権威的に採用する(以前のように黙って実際の
  connectionsへ差し替えたりしない)。
- ドラッグでの複数セル駅建設(`applyStationPathDetailed`)を本線に配線。1ドラッグ=1駅
  (`MAX_STATION_DRAG_CELLS=8`でセル数を打ち切る)。

### 代替案として却下したもの
- **隣接構造からの自動推測(旧`inferStationAxis`)を唯一の決定経路にする案** —
  「なんとなく建つ」の代表例で、プレイヤーが意図した向きと違う駅が建ってしまう事故が
  レビューで指摘されていた。OpenTTD式に明示選択へ切り替え、推測は省略時のフォール
  バックとしてのみ残した(下記Gotchas参照)。
- **矛盾時に黙って実際のconnectionsへ差し替える(旧挙動)** — サイレントな挙動変更は
  「意図と結果の一致」という目的に反するため、明確な拒否+理由表示に変更した。

## 決定3: 車庫の自動接続は「向いている1方向だけ」

### 決定
- `connectDepotToFacingNeighbour`(`construction.ts`)が、車庫設置時に隣接する既存の
  rail/stationセルのうち、車庫が向く1方向(`DEPOT_FACING_NEIGHBOURS`、優先順位
  N→E→S→W、`updateDepotRotation`と共有)だけへ、reciprocal-bitモデル(`pathfinding.ts`
  の`resolveEntryLayer`)が要求する「隣接セル側から車庫へ戻る接続ビット」を追加する。
- 隣接が坂などで`allowedRailConnections`が許さない向きだったり、既存rampの軸と交差
  する向きだったりする場合は、その1接続だけを黙ってスキップする(車庫自体の設置は
  失敗させない)。

### 代替案として却下したもの
- **4方向すべてを自動接続する案** — 車庫はダイヤモンドクロッシングのような複数出入口
  を持たない前提(単一出入口)なので、4方向接続は車庫の意味論そのものを壊す。向いて
  いる1方向のみに限定した。

## 決定4: 地上レールの自動整地(埋め立て)、raise-onlyでother斜面だけ救済

### 決定
- `resolveGroundRailPlanWithAutoFill`(`construction.ts`)が、素の地形で
  `reason:'other-slope'`(単一/対角コーナーだけ低いいびつな形)になった経路だけ、
  `tryAutoFillOtherSlopes`→`applyCornerFill`(`terrainOverlay.ts`)でセルごとに
  「最も低いコーナーを、そのセルの最も高いコーナーまで引き上げる」ことでflatへ均し、
  再判定する。
- **常にraise方向のみ**(`target.height <= current`なら無視)。切り下げは実装しない。
- 変更コーナー数 × `TERRAIN_EDIT_COST_PER_CORNER`(`terrainOverlay.ts`)を
  `costOfTerrainEdit`(`economy.ts`)経由でコストへ加算し、`BuildPreview.terraformCorners`/
  `terraformCost`としてUIへ返す(GameUIは「整地含む n」と表示)。
- 差分は既存の`CornerDiffs`(手動地形編集と同じオーバーレイ状態)へ永続化する。専用の
  別ストレージは作らない。
- トンネル解決(`resolveGroundRailPlanDetailed`が最初からtunnel役割つきのplanを返す
  ケース)は埋め立てより優先される。地形が十分高くトンネルで貫ける区間はそもそも
  `reason`が付かないため、この埋め立て経路に入らない(=トンネルで通せる山を掘り崩して
  埋め立てにすり替えることはない)。

### 代替案として却下したもの
- **OpenTTD式の「基礎(foundation)」を採用する案** — 段差のあるセルの下に土台構造物を
  自動生成して見た目だけ平坦に見せる方式。描画パイプライン(`bakedMesh.ts`・
  `trackGeometry.ts`)への影響が大きく、このバッチのスコープでは実装せず、地形そのもの
  を書き換える埋め立てで代替した。foundation自体は依然として未採用のまま。
- **切り下げ(lower)も含める案** — 「低い方に合わせて削る」は周辺セルの見た目を大きく
  変え、意図しない地形破壊になりやすいため却下。raise-onlyに限定した。
- **`direction-blocked`/`edge-discontinuous`/`tunnel-exit-mismatch`も埋め立てで救済する案**
  — これらはコーナーの高低差の問題ではない(接続方向や坑口標高の不一致)ため、埋め立て
  ても解決しない。対象を`other-slope`のみに限定した。

## Gotchas(既知の癖・注意点)

- **`axis`省略時は旧`inferStationAxis`が今も生きている**。`applyStationDetailed`の
  `axis`引数はoptionalで、省略すると隣接する既存の線路・駅から推測する旧経路
  (`resolvedAxis: StationAxis = axis ?? inferStationAxis(...)`)にフォールバックする。
  これは高架(`applyElevatedStation`系)・地下駅と、`axis`を渡さない既存テストの互換の
  ために残してある。`stationAxisConflict`のチェックは`axis`を明示的に渡した呼び出しに
  しか効かないので、省略経路は従来通り「なんとなく建つ」ままである。
- **高架・地下の駅は現状1セル単位・軸の概念なし**。今回のドラッグ駅建設・axis厳格化は
  地平の`applyStationPathDetailed`が対象で、`applyElevatedStation`/地下駅側には及んで
  いない。
- **埋め立ての失敗はセル単位のno-op**。`applyCornerFill`はそのセル(とBFS伝播で触れた
  隣接コーナー)のどこか1つでもブロック(既存rail/町タイル/水域/範囲外)に触れると、
  その1セルぶんの埋め立て全体を同一参照で握りつぶし(そのセルはotherのまま)、後続の
  `resolveGroundRailPlanDetailed`の判定([edge-discontinuousなどとして]失敗)に委ねる。
  他のセルの埋め立ては独立して進む(経路全体が1つの理由でまとめて中断するわけではない)。
- **`stationAxisConflict`は`'cross'`を渡した呼び出しをチェックしない**。十字乗換駅を
  明示的に作る稀な呼び出し経路は、矛盾判定の対象外のまま通る。
- **`MAX_STATION_DRAG_CELLS=8`はUIのドラッグ操作のみに効く上限**で、
  `applyStationPathDetailed`自体はそれより長いpathを渡されても機能上は動く(呼び出し側
  でクランプしている)。
