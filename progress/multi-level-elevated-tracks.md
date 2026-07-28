# 多レベル高架(離散レベル1〜3)への一般化

## 決定
- `CellData.upper`(1レベル固定)を廃止し、`uppers?: Partial<Record<1|2|3, {connections; stationId?}>>`に一般化。高さはレベルLで`L*OVERPASS_HEIGHT`。
- `CellData.ramp`に`base?: number`(坂の下側レベル、省略時0=地平)を追加。坂は`base`〜`base+1`の1段差を2セル(level1=下段/level2=上段)で結ぶ。既存の`level`(1|2)フィールドの意味は変えていない。
- `StationData.cells[].layer`を`0|1|2|3`に拡張。
- `sim/trackPath.ts`の`rampHeightAtPos(pos, base=0)`に一般化: `(base + smoothstep01(pos)) * OVERPASS_HEIGHT`。`MAX_ELEVATED_LEVEL=3`を追加。
- `sim/pathfinding.ts`: `Layer = 0|1|2|3`型を追加。`resolveEntryLayer`に`prevLayer`引数を追加し、(a)直前の走行層と同じ候補を最優先、(b)無ければ坂(`ramp.base`)による1段差の遷移を許可、(c)それも無ければ地平優先、で層を一意に決める。
- `sim/construction.ts`:
  - `planElevatedPath(length, startCont, endCont, targetLevel)`: 自由端の坂は`2*targetLevel`セル(1段差につき2セル、baseを0から積み上げ)。
  - `resolveElevatedPathEnd(railMap, pos, level)`: `continuesElevated`は**そのレベルの桁が既にあるか**だけを見る(他レベルは無視、独立して併存できるため)。`existingLevel`は別レベルの桁があれば返す(情報用途。呼び出し側で無条件にブロックはしない — 別レベルの桁の上に新しいレベルの坂を通すのは正当な構成のため)。
  - `applyElevatedPath(..., level)`: 桁は`uppers[level]`にOR。`level===1`のときのみ地平connectionsの平面交差ビットを剥がす(従来互換)。`level>1`では下位レベルの線路には触れない。同一レベルへの二重架けのみ禁止、異なるレベルは併存可。
  - `applyElevatedStation(..., level)`・`removePath`・`revertDanglingRamps`をレベル対応に一般化(`removePath`は対象セルの全レベルの`uppers`をまとめて撤去する仕様のまま)。
- `sim/reservation.ts`: `reservationKey`のキーを`x,z:u1`〜`u3`に拡張(高架レベルごとに独立した閉塞資源)。
- `sim/simulation.ts`: `Grid.layer?: 0|1|2|3`。`cellCentreHeight`/`interpCellHeight`は正規化posではなく高さ自体を線形補間する方式に変更(区間ごとにbaseが異なり得るため、より安全な一般化)。
- `sim/persistence.ts`: `SaveDataV13`を追加(構造はV12と同一、CellDataの形が`uppers`に変わった区切り)。V12以前の読み込みで`upper`→`uppers[1]`、`ramp.base??0`を補うマイグレーションを追加。

## 代替案として却下
- `resolveElevatedPathEnd`が別レベルの桁を検出したら常に建設不可にする案 → 「レベル1の桁の上にレベル2の坂を新たに通す」という正当なケースまでブロックしてしまうため却下。既存の同レベル二重架け禁止チェックだけで十分。
- `interpCellHeight`をpos補間のまま一般化する案 → base(坂の下位レベル)が区間の前後で異なりうる一般ケースでは破綻するため、高さ自体を補間する方式に変更。

## 制約・注意
- `src/components/`・`src/render/`は今回`uppers[1]`固定の機械的読み替えのみ(多レベルの見た目対応は未着手、後続タスク)。
- v12以前のセーブに存在した「upperはあるがconnections=0」というエッジケースの後方互換コードは、`uppers`移行時に単純化して削除した(実質発生しない状態のため)。
