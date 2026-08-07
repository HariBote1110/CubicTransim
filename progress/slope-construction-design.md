# P7: 標高上の建設(勾配レール)の設計

## Decision

OpenTTD の傾斜モデル(progress/openttd-slope-notes.md)を簡約して導入する。方針は
**「まず foundation(基礎)なしの OpenTTD」**: 建てられる形を絞る代わりに実装を薄く保ち、
足りなければ地形編集(terraform)で整地してもらう。terraform は既に P2 で TTD 同等の
ものが入っているため、このトレードオフはゲームとして成立する。

1. **セル形状は cellCornerHeights から都度導出**(保存しない)。分類は
   `slopeOf(corners)`: `flat`(4隅同値) / `incline`(一辺の2隅が+1: N/S/E/W の4種) /
   `other`(1隅・3隅・対角など)。急斜面(段差2)は 1-Lipschitz 保証により存在しない
2. **線路の建設可否**:
   - `flat` セル: 任意の標高で従来どおり全方向可(駅・車庫・信号も flat なら任意標高で可)
   - `incline` セル: 傾斜軸に沿った直進のみ可(N傾斜なら N-S 接続のみ)。カーブ・分岐・
     駅・車庫・信号は不可
   - `other` セル: 線路不可(整地してから)。foundation は将来拡張(導入するなら
     openttd-slope-notes.md の leveled foundation 4ケース簡約に従う)
3. **接続の標高連続性**: 隣接セルの線路が繋がる条件は「共有辺の2隅の標高が両セルで一致」。
   flat同士は同標高、incline は低い側の辺が隣の flat と、高い側の辺が+1 の flat と繋がる
   (=1セルで1段登る。OpenTTD と同じ勾配レート)
4. **mountain 概念の廃止**: `terrainTypeAt` の mountain は「建設不可の障害物」ではなくなり、
   「標高1以上」の表示上の区分に格下げする。旧・山岳トンネル規則(坑口・内部非表示)は
   「線路の走行標高より地形が高い区間」に対して適用する形へ一般化する(高架トンネルの
   isMountainInteriorAtLevel と同型の判定を地上レールにも使う)
5. **列車の高さ・姿勢**: 走行線(trackPath)の各点で標高をコーナー双線形補間し、
   renderPos.y に反映。既存の高架 ramp の pitch 計算(前後台車ベース)を流用する
6. **町・水域**: 町タイルは当面 flat セルのみ(標高任意)。水域は従来どおり標高0固定
7. **経路探索・予約**: セル接続グラフ自体は connections ビットのまま(建設時に標高連続性を
   保証するので、走行時は従来ロジック無改修が原則)。高架(uppers)との相互作用:
   高架レベルは「地表標高+level」ではなく従来どおり絶対レベルとして維持し、
   標高のあるセルへの高架は当面禁止のまま(P8地下と合わせて後日一般化)

## 実装順(サブフェーズ)

- P7a: sim/slopes.ts 新設 — slopeOf / 線路可否 / 辺標高の連続性判定(純関数、TDD)。additive
- P7b: construction.ts 統合 — 「mountain=不可」を標高規則へ置換、パス建設の連続性検証、
  トンネル規則の一般化、コスト(incline セルは割増)
- P7c: 描画 — trackGeometry/trackPath の標高追従、TerrainBlocks は既に傾斜メッシュ対応済み、
  列車の y/pitch、建設プレビューの標高表示
- P7d: 駅・車庫・信号の任意標高化、町タイルの標高対応、UI フィードバック

## Alternatives considered

- **foundation 完全実装(TTD忠実)**: 初手では棄却。傾斜×線路方向のテーブルと基礎描画の
  工数が大きく、「整地すれば同じことができる」ため優先度が低い。P7d 以降の拡張余地として残す
- **勾配を2セルで1段(緩勾配)**: 既存の高架 ramp が「1セルで OVERPASS_HEIGHT」の急坂で
  確立しているため、整合を優先して1セル1段を採用

## Constraints / Gotchas

- 標高連続性は「建設時に保証」する設計なので、terraform で線路セルの標高を変える編集は
  従来どおり blockers で禁止のまま(これを緩めると走行時検証が必要になる)
- trackPath の y 補間は「セル中心線に沿った断面標高」であり、コーナー標高の双線形と
  厳密には一致させること(レールと列車のずれ防止。CLAUDE.md の trackPath 原則)

## P7a実装メモ

- `src/sim/slopes.ts` を新設(construction.ts/描画には未配線、additive)。
  `slopeOf`/`allowedRailConnections`/`edgeHeights`/`railEdgeContinuous`/
  `canPlaceFlatStructure`/`pathSlopeViolations`/`SLOPE_RAIL_COST_MULTIPLIER`(=2)を実装。
- `edgeHeights` はコーナー順を `N:[nw,ne] S:[sw,se] E:[ne,se] W:[nw,sw]`、対角は共有1頂点を
  2要素とも同値で返す規約にした。実物の `TerrainField`(コーナーが隣接セル間で物理共有される)
  なら、隣接セルの `edgeHeights` は常に要素ごと一致する(=`edge-discontinuous` は構造的に
  発生しない)。このケースをテストするにはコーナー共有を無視する field ダブルが必要だった
  (`slopes.test.ts` 参照)。実運用では `pathSlopeViolations` の他チェック
  (`other-slope`/`direction-blocked`)の方が主戦場になる見込み。
- `pathSlopeViolations` は construction.ts の `mountainCellCandidateDirs` と同型の
  「path[i]がprev/nextへ向かう方向」導出を流用しつつ、行き止まりの反対側候補は追加しない
  (山岳坑口ルールと違い、勾配可否判定には実際に必要な接続方向だけを見れば足りるため)。

## P7b実装メモ

- `construction.ts` に `resolveGroundRailPlan(field, path)` を新設し、地上レール建設の
  中核をこれに一本化した。パス上の各セルを `{kind:'ground', slope:'flat'|'incline'}` か
  `{kind:'tunnel', height}` に解決する純関数。
  1. 経路全体が勾配追従可能(全セルflat/incline+必要方向OK、かつ連続する辺の標高が
     繋がる)なら全セル`ground`。
  2. そうでなければ、勾配追従が破綻する連続区間(other-slope/direction-blocked、および
     隣接セル同士が個別にはOKでも辺が繋がらない`edge-discontinuous`はdownstream側を
     bad扱いにして区間へ含める)を洗い出し、その区間の「地形の最大コーナー標高」が
     区間手前のground最終セルのrailHeightAt(先頭から始まる場合は区間先頭セルの最低
     コーナーで代用)より高ければ、その区間全体を進入標高で貫く`tunnel`にする。
  3. 区間直後にセルがあれば、その標高が進入標高と一致すること(坑口の標高連続性)も
     要求する。区間内のどれか1セルでも地形が「高くない」、または出口の標高が
     一致しなければ、経路全体を建設不可(null、呼び出し側はno-op)にする。
  - 「地形が高いか」の判定はコーナーの**最大値**(`Math.max(...corners)`、field.cellHeightAtの
    min則ではない)を使う。標高3の台地の境界セル(例: 4隅`[0,0,3,3]`のようなotherスロープ)は
    min則だと0になり、実際にかぶさっている地形の存在を見逃してしまうため
    (トンネルを掘るべき土被りの有無を表すにはmax則が適切という判断)。
- `CellData.tunnel` を `boolean` → `{ height: number }` に拡張した(types.ts)。旧・
  「terrainTypeAt==='mountain'なら機械的にtunnel:true」を廃止し、実際に線路が通る標高を
  保持するようにした。`tunnel.ts`(坑口列挙・内部判定)は`cell.tunnel`の truthy 判定だけを
  使っており、値がbooleanからオブジェクトに変わっても挙動は変えていない(既存の坑口ロジック
  はそのまま流用できた。「corner heights vs tunnel height」への一般化は、境界判定自体が
  construction.ts側の建設時チェック(上記2〜3)に前倒しされたため、tunnel.ts側で新たに
  比較ロジックを持つ必要は無かった)。
- `slopes.ts` に `railHeightAt(field, cell, x, z)` を追加。flatはその標高、incline は
  **低い側の辺の標高(base)**、tunnelは保存された高さをそのまま返す(P7c以降の描画・
  列車のy座標計算でも再利用できる位置に置いた)。`pathCellConnectionDirs` もexportし、
  construction.tsのresolveGroundRailPlanと重複実装しないようにした。
- 駅・車庫・信号の設置条件(`isBuildableGround`)を「terrainTypeAt==='grass'」から
  「水域でない、かつ`slopes.canPlaceFlatStructure`(コーナーがflat)」へ置換した。
  「表示上mountain分類なだけで実際は平坦(min則で4隅とも標高0に潰れる)」なセルには
  任意標高で駅・車庫・信号・線路を置けるようになった(mountain概念の廃止)。
  一方、自由な高架線の坂(ramp)は従来通り「標高0の地平」専用のガードが必要なため、
  `isFlatGroundLevelZero`(isBuildableGround + 標高0)を別途新設して
  `isElevatedConnectPlanBuildable`/`applyElevatedPath`のramp判定に適用した(design docの
  「Elevated tracks: unchanged」を維持する目的。isBuildableGroundの緩和をそのまま
  流用すると、flatな高原(標高1以上)にも坂が建てられてしまうため)。
- `pathHasUnsupportedMountainCell`/`mountainCellCandidateDirs` は削除した。「坑口 or
  天井が覆われた内部セル」という旧ルールの目的(斜面フリンジへのレール突き出し防止)は、
  resolveGroundRailPlanの「地形が進入標高より高いか」「出口標高が一致するか」という
  新ルールに完全に置き換えられたため。
- コスト計算: `economy.ts` に `costOfGroundRailPlan(path, field, plan)` を新設。
  tunnelセルは従来通り`TUNNEL_COST_MULTIPLIER`(8倍)、inclineセルは新設の
  `SLOPE_RAIL_COST_MULTIPLIER`(2倍、slopes.ts)、水域flatセルは`BRIDGE_COST_MULTIPLIER`
  (5倍)。`costOfPath`(mode:'rail')・`buildPreview.evaluateBuild`の両方をこの関数に
  問い合わせる形へ更新し、UI側にルールを書き写さないという既存方針を維持した。
- SaveData: バージョンは15のまま据え置いた(pre-release、ユーザー明言によりv15内での
  破壊的変更を許容)。ただし`CellData.tunnel`の形状変更により、**v15のセーブでも
  P7b以前に保存された`tunnel:true`のセルは、読み込み後の型と食い違う**(実行時に
  `cell.tunnel.height`へアクセスするコードは`undefined`を返すため、坑口自体は
  従来通り表示されるが高さ情報は無いものとして扱われる)。移行処理は書いていない
  (v15内はまだ移行対象にしないという既存方針に従った)ため、P7b以前のセッションで
  保存したv15セーブは、山岳区間の見た目・建設可否が変わりうる。`persistence.test.ts`に
  `tunnel:{height:2}`セルを含むラウンドトリップ検証を追加した。

### 挙動変更(意図的)

- 1セル1段のなだらかな起伏はトンネルではなく勾配追従(incline)で登れるようになった
  (旧・`pathHasUnsupportedMountainCell`のテストにあった「3x3山塊を貫く」ケースは
  トンネル不要になり、傾斜レールで建設できる)。
- min則コーナー導出で実体の無い(4隅とも標高0に潰れる)「表示上mountain分類なだけ」の
  セルは、駅・車庫・線路すべて無条件で建設可能になった。
- `debugScenarios.ts`の`mountain-tunnel`シナリオは、なだらかな起伏(1セル1段)では
  もはや再現できなくなった「本当にトンネルが必要な急峻な地形」を表現するため、
  `fieldFromMaps`(セル標高からコーナーをmin則で導出)ではなく`TerrainField`を直接
  実装するテストダブルへ作り替えた。

### ブラウザ検証(実地形での確認)

- 開発サーバ(port 5175)で通常マップ(小、91×91)を生成し、`window.__debugWorld.terrainField`
  (実際に生成されたcreateTerrainField)に対して`resolveGroundRailPlan`/`applyRailPath`を
  動的import経由で直接呼び、実地形での挙動を確認した(UIのドラッグ操作はcanvas上の
  pointer drag再現がジオメトリ的に安定せず、今回は建設ロジック自体をJSコンソールから
  実地形に対して直接検証する形にした):
  - 実際に見つかった incline セル(dir=E, low=0/high=1)を通る経路 `[(-19,0),(-18,0),(-17,0)]`
    は3セルとも`ground`(flat→incline→flat)で建設でき、`tunnel`は一切付かないことを確認。
  - 実際に見つかった otherスロープを含む経路 `[(-23,-2)..(-17,-2)]`(7セル)は、
    手前5セルが`ground`(flat)、末尾2セルが`tunnel:{height:0}`になり、
    `costOfGroundRailPlan`が700(平地7セル)ではなく2100(5×100 + 2×100×8)を返す
    ことを確認(トンネル分の割増コストが正しく効いている)。
  - 実際に山から離れた平地(z=30)への線路・駅2件の建設は従来通り正常に動作することを確認。

## P7c実装メモ

- 高さの一本化: `sim/slopes.ts`に`groundRailCentreHeight(field, cell, x, z)`(=`railHeightAt`の
  整数段数をOVERPASS_HEIGHT単位のワールドYへ換算するだけの薄い関数)と、render側の部品分けに
  必要な`railRenderHeight`(flat/tunnelは単一のy、inclineは低い側/高い側の2値+dir)を追加した。
  sim(renderPos/carPositions)とrender(TrackNetwork)は両方ともこの2関数だけを経由し、地形段数→
  ワールドYの換算式を重複させていない(CLAUDE.mdのtrackPath原則どおり)。
- 列車の高さ: `sim/simulation.ts`の`cellCentreHeight`/`cellRampHeight`と`sim/consist.ts`の
  `trackCentreHeight`に`terrainField`を追加引数として通し、layer(高架)でもramp(坂)でもない
  地上セルは`groundRailCentreHeight`を上乗せするようにした。`terrainField`省略時(既存の
  ユニットテストのフィクスチャなど)は従来どおり0のままなので後方互換。trackPath.tsの
  `cellCurveHeight`/`pathHeightAt`(既に坂の縦曲線描画のために存在していた「隣接セル中心高さを
  2次ベジェで補間する」機構)をそのまま再利用でき、新しいイージングを発明する必要はなかった。
- 地上レールの描画: `render/trackGeometry.ts`に`buildGroundInclineTrackParts`を追加。incline
  セルは地形コーナーが作る面が文字通り線形(1段/セル)なので、坂(ramp)のsmoothstepとは別に、
  低い側境界→高い側境界を直線で結ぶだけの2点ポリラインにした(既存の`layTrackAlong`をそのまま
  再利用。バラスト・枕木・レールの生成方法はramp/flatと共通)。`TrackNetwork.tsx`は`field`を
  新たにpropで受け取り、セルごとに`railRenderHeight`で分岐: incline→`buildGroundInclineTrackParts`、
  flat/tunnel→`buildCellTrackParts`にoriginYを渡すだけ。ramp/高架(uppers)の既存ロジックは
  無改修(どちらも「標高0の地平」前提のまま、P7bのisFlatGroundLevelZeroガードで担保されている)。
- 駅・車庫・信号・駅舎・建設プレビュー: `GameScene.tsx`で`field.cellHeightAt(x,z)*OVERPASS_HEIGHT`
  を各要素のy座標に加えた。駅・車庫・信号はP7aの規則で常にflatセル限定のため、単一の代表標高で
  十分(inclineの低い側/高い側の使い分けは不要)。
- トンネル坑口: `sim/tunnel.ts`の`TunnelPortal`に`height`フィールドを追加した。地平の坑口は
  `cell.tunnel.height`、高架の坑口(`ElevatedTunnelPortal`)は従来どおり`level`をそのまま詰める。
  `GameScene.tsx`の坑口`faceY`は`portal.height * OVERPASS_HEIGHT`の1本の式で地平・高架どちらも
  扱えるようになった(旧`portal.level * OVERPASS_HEIGHT`は地平が常に0固定だったため、地平トンネルが
  標高を持つP7bの変更後は誤った高さになるところだった)。ヘッドウォールの高さ自体
  (`computePortalHeadwall`の`MIN_HEADWALL_HEIGHT`)はP7b以前から既に「基準面からの相対値・固定」
  という設計だったため無改修で済んだ。
- 列車のトンネル内非表示判定(`isTrainHiddenInTunnel`)は地平側(`isInTunnelInterior`)がx,zだけを
  見る実装だったため、tunnel.heightが可変になっても無改修で動作する。
- ブラウザ検証: `terrain-playground`シナリオ上で盛土ツールを使い、原点付近に1クリックで
  小さな丘(flat0→incline→flat1(頂上)→incline→flat0)を作った上で、直線の線路を丘越しに敷設・
  頂上に駅・麓に車庫を設置して確認した。
  - (a) 敷設した線路は丘の断面(隣接セル境界)でギャップなく連続してレールが登り降りするのを
    スクリーンショットで確認(`buildGroundInclineTrackParts`のレールが地形メッシュの傾斜面に
    正しく追従)。
  - (b) `__dbgStep`で列車を丘越しに走らせ、`__debugWorld.runtimes`の`renderPos.y`が地平基準0.5から
    傾斜区間で0.5〜1.3(=0.5+OVERPASS_HEIGHT×1)へ連続的に増加することを確認。スクリーンショットでも
    車体が斜面に沿って傾いて描画されているのを確認。
  - (c) `mountain-tunnel`デバッグシナリオで坑口が斜面に正しく接し(浮き・めり込みなし)、列車が
    トンネル内部で非表示になる従来の挙動が保たれていることを確認(地平トンネルなのでheight=0の
    ケースだが、坑口高さの式自体は共通化済み)。
  - (d) 丘の頂上(flat1)に置いた駅が地形標高ぶん正しく持ち上げられ、列車がホーム位置で
    浮き/めり込みなく停車できることを確認。
  - (e) `multi-level-crossing`(高架Lv1〜3の立体交差)デバッグシナリオを`__dbgStep`で走らせ、
    高架・坂(ramp)の見た目・列車の走行が従来どおりであることを確認(地上標高絡みのP7cの変更が
    高架系統に影響していない)。
