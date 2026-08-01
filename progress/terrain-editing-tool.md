# OpenTTD風の地形編集ツール(盛土/切土)

## 概要

OpenTTDのterraformにあたる地形編集を追加した。ツールバーの「盛土」(キー7)・「切土」(キー8)で
矩形範囲をドラッグ選択し、範囲内のセルの標高を1段上げ下げする。標高(heights)が一次データ・
`normaliseHeights`で隣接段差1以下(1-Lipschitz)を保証・`MOUNTAIN_HEIGHT_THRESHOLD=1`という
既存の地形設計(progress/heights-primary-terrain.md)の上に載る形で実装した。

## sim層: `src/sim/terrainEdit.ts`

- `rectCells(a, b)` — 対角2点が囲む矩形の全セル(OpenTTD流の矩形ドラッグ選択)。x昇順→z昇順。
- `applyTerrainEdit(heights, terrain, railMap, townTiles, cells, mode, range?)` —
  純粋関数。`{ heights, terrain, changedCells }` を返し、変化が無ければ**同一参照**
  (construction.tsのapply系と同じno-op規約)。

### 段差1以下の回復: 方向つき伝播

`normaliseHeights`は「引き下げのみ」のチャンファー距離変換なので盛土には流用できない
(盛った当のセルが引き下げられて編集が消える)。代わりに方向つきのBFS伝播を実装した:

- **盛土**: 隣接セルが `h-1` 未満なら `h-1` へ引き上げて伝播
- **切土**: 隣接セルが `h+1` 超なら `h+1` へ引き下げて伝播

編集前が1-Lipschitzであれば、±1段の編集で各セルの変化は常に±1段に収まる(伝播は
「1段の波」が裾へ広がるだけ)。プロパティテスト(ランダム地形に200回のランダム矩形編集)で
「常に1-Lipschitz・0..TERRAIN_HEIGHT_MAX」を検証している。

### ブロック規則(編集全体がno-op、部分適用はしない)

影響セル(**伝播で動くセルを含む**)のどれかが以下に該当すると同一参照を返す:

- `railMap`に存在するセル(線路・駅・車庫・信号)。高架桁だけのセルも安全側で一律ブロック
  (高架下の地面だけ盛る、は将来課題)
- 水域(waterは常に標高0。盛土・切土とも不可。水域の隣を高さ2にする編集も、伝播が水域へ
  及ぶためブロックされる)
- 町タイル(家・道路の両方)
- `TERRAIN_COORD_RANGE`の範囲外(範囲外は標高0の固定点。縁のセルを高さ2以上にする編集は
  伝播が範囲外へ及ぶためブロックされる。高さ1まではOK)

### 地形種別の不変条件

編集後も「water以外は mountain ⟺ 標高>=MOUNTAIN_HEIGHT_THRESHOLD(=1)」を保つ。
盛土で1段以上になった草地はmountainに(=トンネル必須の地形に)、切土で0に戻った
mountainはgrass(未登録)に戻る。terrainに変化が無ければこちらも同一参照。

## コスト: `src/sim/economy.ts`

- `TERRAIN_EDIT_COST = 50`(1セル・1段あたり)。線路(100)の半分で、
  「山を1マスぶん整地して平地線路を敷く(50+100)ほうがトンネル(800)より圧倒的に安いが、
  高い山・広い範囲の造成は伝播分も課金されて財布に響く」バランス。
- `costOfTerrainEdit(cellSteps)` — 変化セル数(=changedCells件数。1編集での各セルの変化は
  常に±1段なので件数=総段数)に比例。**伝播で動いたセルも課金対象**。
- 課金は月次台帳の`construction`(建設費)に計上。

## UI

- `GameUI.tsx` — `BUILD_TOOLS`に盛土(7)・切土(8)を追加。`BuildMode`を`'raise' | 'lower'`で
  拡張。差し色は`theme.ts`に追加した`T.terrain`。プレビューバッジは伝播分を含む
  課金対象セル数とコストを表示(可否はevaluateBuild経由)。
- `buildPreview.ts` — `evaluateBuild`に'raise'/'lower'を追加。実際に`applyTerrainEdit`を
  呼び、同一参照比較で'no-effect'を判定する(UIに条件を書き写さない既存規約のまま)。
  引数に`heights`を追加(省略時は空=全平地)。
- `useGameLogic.commitPath` — 'raise'/'lower'は`applyTerrainEdit`→変化があれば
  `setHeights`+`setTerrain`+課金、で完結する別系統(railMap/stationsは触らない)。
- `GameScene.tsx` — 地形編集モードでは選択が8方向の直線(getConstrainedPath)ではなく
  **矩形**(rectCells)になる。プレビューのゴーストはセルの現在標高の上
  (`heights×OVERPASS_HEIGHT`)に重ねる。
- `TerrainBlocks.tsx` — `pickable` propを追加。地形編集モード中だけ地形の上面メッシュ
  (草地・雪)がポインタを拾い、GameSceneのハンドラを発火する(ハンドラ側で
  stopPropagationし、背後の地面プレーンがずれたe.pointで二重発火しない)。これにより
  丘の頂上をクリックしても直交カメラの見え方のずれで手前のセルが選ばれる問題が起きない。
  raycastは「propを外すとr3fが既定へ戻す」ことに依存せず、
  `THREE.Mesh.prototype.raycast` / `() => null` を常に明示的に渡す。

## 永続化

標高はSaveData v14で既に一次データとして保存されている(往復テスト済み)ため変更なし。
編集後のterrain(mountain⟺標高1以上)もv14の不変条件と同じなので移行不要。

## テスト

- `terrainEdit.test.ts`(30件) — rectCells、基本の±1段、上限/下限、伝播の正しさ、
  1-Lipschitzプロパティ、mountain⟺標高1以上プロパティ、ブロック規則(選択セル・
  伝播セルの両方、rail/駅/車庫/信号/町/水域/範囲外)、同一参照no-op、コスト。
- `buildPreview.test.ts`に4件追加 — ok/no-effect/insufficient-funds/伝播分のコスト。

## 既知の制限・将来課題

- 高架桁だけのセル(地平が空)も一律ブロックしている。「高架下の地面を盛る」は
  桁下クリアランスの検証が必要になるため見送った。
- 列車の現在位置は見ていない(railMapブロックにより線路上は編集できないので実害なし)。
- 水面の掘り下げ(新しい湖を作る)・埋め立ては未対応(waterは標高0固定のまま)。
