# 単発クリックで立体交差セルに駅が置けない不具合(pointerdown/pointerupのstate競合)

## 症状
地平の線路と高架桁が重なる交差セルに対して、駅(station)・高架駅(elevated-station)を
単発クリックで設置しようとすると何も起きず課金もされない。同じセルへ隣のセルから
短くドラッグすると正常に設置できる。

## 原因
`GameScene.tsx` の建設コミットは、地面プレーン1枚に張った `onPointerDown`/`onPointerUp`
で完結しており、レイキャストの素通し(`raycast={() => null}`)は別件で既に対応済みだった
(`progress/raycast-passthrough-for-decoration-meshes.md`)。今回の原因はイベント伝播では
なく、**React state の読み出しタイミング**だった。

- `handlePointerDown` は押下位置を `setDragStartPos` (useState) に保存する。
- `handlePointerUp` は自分のクロージャが閉じ込めている `dragStartPos` を読んで
  コミットの可否・パスを決める。
- 「動かさない単発クリック」は pointerdown→pointerup が同一tick内で連続発火し、
  間に pointermove由来の再描画が挟まらない。この場合、pointerup 側のハンドラ関数は
  **まだ再描画されていない1つ前のレンダー**でクロージャ化されたものが呼ばれるため、
  読み取る `dragStartPos` は「たった今の pointerdown で更新されたはずの値」ではなく、
  **1クリック前の値**(モード切替直後なら `null`)になる。
- ドラッグでは pointerdown→pointermove(複数回)→pointerup と間に再描画が挟まるため、
  症状が出なかった。

計装(`window.__dbgDown`/`__dbgUp` に押下・離上時のセル座標とその時点の`dragStartPos`を
記録)で実機再現して確認。交差セル(3,4)への単発クリックでは
`down.pos={x:3,z:4}` に対し `up.dragStartPos=null` で不発、直後に別セルへ単発クリックした
ときの `up.dragStartPos` が **前回クリックの (3,4)** になっており、駅がそこに1クリック
遅れで建つ現象を確認した(=交差セル特有ではなく単発クリック全般に潜む不具合で、
たまたま「最後のクリックが不発に見える」形で交差セルの操作性バグとして顕在化していた)。

## 修正
`dragStartPos` の実体を `useRef` (`dragStartRef`) に持たせ、`handlePointerDown` で
同期的に書き込み、`handlePointerUp` は state ではなく ref を読んでコミット判定する。
useState の `dragStartPos` はプレビュー表示(`previewPath`のuseMemo)用にそのまま残す。
ref は再描画を待たずに即座に更新されるため、down→up が同一tickで走っても最新値が読める。

## 検証
実機(Browser)で以下を確認した。
1. z=4行に地平線路(x=2〜5)、x=3列に高架(z=2〜6)を敷き、交差セル(3,4)が
   `{type:'rail', connections:34, upper:{connections:136}}` になることを確認。
2. 駅ツール(3)で交差セルを単発クリック→ `railMap.get('3,4')` が `type:'station'` になり、
   `stations` に1件登録されることを確認。
3. 続けて高架駅ツール(8)で同じ交差セルを単発クリック→ 同一 `stationId` に
   `upper.stationId` が追加され、`stations` の該当エントリの `cells` が
   `[{x:3,z:4}, {x:3,z:4,layer:1}]` の2件になることを確認(1駅IDに地平・高架両ホーム)。
4. 車庫を単発クリックで設置→列車購入→選択→ドラッグでの置き直し操作もエラーなく
   動作することを確認(列車ドラッグは `trainPress`/`draggingTrainId` という別のstateを
   使っており、今回の修正対象外)。

## 積み残し
- 同種の「単発クリックが1つ前のstateを読む」レースは、他に state を直接
  useState 経由でしか保持していない pointerdown→pointerup の組み合わせが増えたら
  再発しうる。今後この手のコミット判定を追加する際は、pointerdown で確定させたい値は
  ref にも書く方針を踏襲すること。
