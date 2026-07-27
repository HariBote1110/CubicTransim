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
