# デバッグシナリオメニュー

「デバッグモードに、あり得るシチュエーションを列挙しておきたい。今は坂しかなく、
無用の長物と化してしまってる」というフィードバックを受け、起動ダイアログの
デバッグモードを単一シナリオ(坂・高架・往復列車)からシナリオメニューに拡張した。

## 設計

- `src/sim/debugScenarios.ts`(新規、純粋関数のみ)に `DEBUG_SCENARIOS: DebugScenarioDef[]`
  を定義。各エントリは `{ id, label(日本語), description(日本語一行), build() }`。
- `build()` は `DebugScenarioWorld` を返す。旧 `DebugScenario`(railMap/stations/trains)の
  上位互換で、`terrain` / `heights` / `towns` / `groups` / `money` を任意で上書きできる。
- 世界の組み立ては既存の `createDebugScenario` と同じ流儀で、`construction.ts` の
  apply系(`applyRailPath` / `applyElevatedPath` / `applyStation`)を使う。UI側に建設
  条件を書き写さない、という既存方針のまま。
- 旧 `debugScenario.ts` はそのまま残し(既存テスト・importは無変更)、シナリオ#1の
  `build` として再利用する。
- `useGameLogic.loadDebugScenario` は `DebugScenarioWorld` を引数に取るよう拡張
  (省略時は従来どおり `createDebugScenario()`)。terrain/heights/towns/groups を
  シナリオ側の値で流し込み、`money` は指定があるときだけ上書きする。
- `App.tsx` の起動ダイアログ: 「デバッグモード(シナリオを選択)」を押すとダイアログ内が
  シナリオ一覧(ラベル+一行説明のボタン、`ui/theme.ts` のトークンでスタイル)に
  切り替わる。「戻る」で開始方法の選択へ戻れる。

## シナリオ一覧

1. **坂・高架・往復列車**(既存) — 地平・坂・高架を1編成が往復。
2. **多層高架と立体交差** — 地平の東西線の上を x=-4/0/+4 で Lv1/Lv2/Lv3 の南北高架線が
   跨ぐ。各高架線は両端の地平引き込み線に `applyElevatedPath` の自動坂(レベルLで片端
   2Lセル)で接続し、地平1+各レベル1の計4編成が走る。
3. **山岳トンネル** — ピラミッド状の尾根 `h = max(0, min(3-|x|, 7-|z|))`(各項が
   1-Lipschitz なので `normaliseHeights` 相当の隣接段差1以下を式で保証)を東西線が
   貫く。x=±2 が坑口、x=-1..1 が内部セル。1編成が往復。
4. **単線行き違い** — `passing-loop.test.ts` の受け入れレイアウトをそのまま再現。
   本線(10..15, z=0)+待避線(11..14, z=1)+信号3基((11,0)東向き・(14,1)西向き・
   (14,0)東向き)。信号の向きは `applySignal` の巡回APIではなく `signalDir` を直接
   設定した(決め打ちのほうが明快)。対向2列車が自動ですれ違う。
5. **分岐と運用グループ** — (0,0)の分岐器で本線(z=0)と斜め分岐の支線(z=2)に分かれ、
   各支線に駅2つ。本線列車は運用グループ(`mode:'shuttle'`)所属で分岐器を通り、
   支線列車は単独運用で支線内を往復(単線の幹線での競合・デッドロックを避ける割り切り)。
6. **大都市と踏切** — 人口50000(上限)の町の縁(z=8)を東西線が貫く。市街地の道路
   サブタイルが線路タイルと同居して踏切になる(テストで踏切タイル>=3を検証)。
   町の成長スケール改修(tile-based-towns.md 追記参照)の目視確認も兼ねる。
7. **地形編集の遊び場** — `generateMap(mulberry32(固定シード))` の起伏地形のみ。
   線路・町なし・所持金999,999,999。盛土/切土ツールの試し場。

## テスト

`src/sim/debugScenarios.test.ts`(新規、15テスト):

- カタログ: idの一意性、7件、日本語ラベル・説明、既存シナリオが先頭。
- 全シナリオ共通: 列車の初期位置が railMap の実在セル、運行表(グループ経由は
  `effectiveSchedule` で解決)の駅が実在、列車ありシナリオは `stepWorld(world, 0.1)×10`
  が例外を投げない。
- シナリオ個別: Lv1〜3の桁+坂の存在、トンネルセル>=3と terrain/heights 上書き、
  信号3基+対向2列車、グループ1つと所属列車の運行表解決、人口50000+踏切タイル>=3
  (`buildTownTileIndex` に railMap を渡して検証)、遊び場の空railMap+heights+money。

## 注意点・学び

- `applyElevatedPath` の端は既存の地平線路に接していれば自動で connect(level 0)扱いに
  なり坂が生える。レベルLの坂は片端 2L セル消費するので、Lv3 は経路長に余裕が要る
  (今回は21セル経路: 坂6+桁9+坂6)。
- 手書き heights を渡すシナリオは隣接段差1以下(1-Lipschitz)を自分で保証すること。
  ピラミッド式 `max(0, min(a-|x|, b-|z|))` は式の形で保証できるので安全。
- `SimWorld.groups` を渡さないとグループ所属列車の運行表が空になる。テストの
  world組み立てで忘れないこと。
