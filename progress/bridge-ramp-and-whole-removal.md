# 橋の坂2セル化と、撤去時の橋全体まとめ撤去

## Decision

- 橋の坂(ramp)を1セルから2セルに拡張した。`CellData.ramp`に`level: 1 | 2`を追加し、
  1が地平寄りの下段(高さ`OVERPASS_HEIGHT/3`)、2が桁寄りの上段(高さ`OVERPASS_HEIGHT*2/3`)。
  橋は「坂(level1)→坂(level2)→橋桁(最低1セル)→坂(level2)→坂(level1)」の構成になり、
  1セルあたりの上昇量が`OVERPASS_HEIGHT/2`から`OVERPASS_HEIGHT/3`に緩和された。
  `MIN_BRIDGE_LENGTH`を3→5、`MAX_BRIDGE_LENGTH`を10→12に変更(坂4セル固定+橋桁最低1セル)。
  旧セーブの`ramp`には`level`が無いため、読み出しは常に`cell.ramp?.level ?? 2`とし、
  桁側に近い急な坂として扱う(移行処理はしない)。
- `applyBridge`の実装は、経路全体(坂+橋桁)にまず通常の地平接続を`applyRailPath`同様に
  敷設し、そのあとで両端2セルずつに`ramp`フラグを立て、中間セル(橋桁)だけ軸方向の
  地平connectionsビットを剥がして`upper`に付け替える、という順序にした。こうすると
  坂セルは自然に双方向の地平connectionsを持つ(通行可能)まま、橋桁だけが`upper`に
  変換される。
- 撤去(`removePath`)は、対象セルが橋の一部(`upper`または`ramp`を持つ)なら、その軸
  方向へ両側にたどって橋を構成するセル(坂4枚+橋桁)を全部集め、まとめて撤去対象に
  加える(`collectBridgeCellKeys`)。橋桁セルの下に独立した地平線路が交差している場合は
  従来通りその線路だけ残す(`upper`だけ外す)。坂セルは通常のrail削除と同じ扱いにして、
  `ramp`の残骸を残さない。
- 従来あった「隣が坂で、その登り方向が今消したビットなら`ramp`を消す」という
  個別ケアのロジックは、橋全体を常にまとめて撤去するようになったことで到達不能に
  なったため削除した。

## Alternatives considered

- 坂を可変長(3セル以上)にする案は見送った。要求は「1セルの急勾配を緩和する」ことで、
  2段階で十分に緩やかになる(1セルあたり0.2 vs 従来0.6、OVERPASS_HEIGHT=0.6換算)ため、
  可変長対応の複雑さに見合わないと判断。
- 撤去時に「橋桁だけ」「坂だけ」を選んで消せるモードも検討したが、ユーザー体験として
  「橋の一部を選んだら橋ごと消える」方が直感的という指摘に合わせ、全体撤去に統一した。

## Constraints / Gotchas

- 坂セルの地平connections剥がしは行わない(橋桁だけ)。もし坂セルの一部だけを個別に
  撤去できるようにする場合、`collectBridgeCellKeys`の軸判定(`bridgeAxisOf`)を
  ram/upperの両方に対応させたままにしないと、坂の片側だけが孤立して残る恐れがある。
- 描画側(`buildRampTrackParts`)は`lowY`/`highY`を明示的に渡す形に変更した
  (旧: 0→rampHeightの固定)。level1は`0→H/3`、level2は`H/3→2H/3`。橋台のくさび
  (`buildRampAbutmentPart`)は地平に接するlevel1側にのみ描画し、level2側には出さない
  (宙に浮いた坂に地面まで届くくさびを描くと不自然になるため)。

## 追記(2026-07-28): 坂の高さを折れ線からsmoothstep曲線に一元化

- ユーザー指摘「橋の傾斜に差し掛かる部分の見た目が急すぎる」への対応。従来はlevel1/level2
  ごとに「地平/level1境界」「level1/level2境界」「level2/桁境界」の3点を線形補間する
  折れ線だったため、各境界で傾きが不連続に変わり、特に地平→坂の取り付き部が急に見えた。
- `src/sim/trackPath.ts`に`smoothstep01(x) = 3x²-2x³`(Hermiteのease-in-out)と、
  正規化位置pos(0=地平, 1/3=level1, 2/3=level2, 1=桁)を受けて高さを返す
  `rampHeightAtPos(pos) = OVERPASS_HEIGHT * smoothstep01(pos)`を追加した。
  地平から桁までを「1本の連続したsmoothstep曲線をposで辿る」ものとして扱うのが要点で、
  posを線形補間してから同じ1つの関数に通すことで、level1/level2の境界(離散的な
  セル境界)をまたいでも折れ角が生じない。両端(pos=0, pos=1)では定義上smoothstepの
  傾きが0に漸近するので、取り付き部・桁への合流部がなだらかになる。
- sim側は`cellCentreHeight`/`interpCellHeight`(simulation.ts)がこの関数を直接使うように
  書き換えた。従来のrampLevelHeight(離散加算)は廃止。
- render側は`buildRampTrackParts`(trackGeometry.ts)が1セルを既定4分割
  (`RAMP_CURVE_SEGMENTS`)し、各分割点のposをrampHeightAtPosに通した高さで
  折れ線近似する形に変更した(sim/renderで同じ関数を共有するので列車とレールの
  高さがずれない、というCLAUDE.mdの既存方針を踏襲)。橋台のくさび
  (`buildRampAbutmentPart`)も同様に縦断プロファイルを持つ`makeCurvedWedgeGeometry`
  に置き換え、地平側(pos=0)で高さ0に収束するようにした。
  `TrackNetwork.tsx`は境界posの定数(`RAMP_BOUNDARY_*`)を通じてposLow/posHighを
  隣接セルとぴったり揃えている。
- 中間の最大勾配(pos=0.5付近)は旧仕様の平均勾配よりやや急になるが、要求通り
  「折れ角を消す」ことを優先した。

## Alternatives considered(追記分)

- レール描画側だけを曲線化し、列車の高さ(sim)は従来の折れ線のままにする案は
  「レールと列車がずれない」というCLAUDE.mdの既存方針に反するため見送った。
  sim/renderの両方が`rampHeightAtPos`という単一の純粋関数を参照する構成にした。
