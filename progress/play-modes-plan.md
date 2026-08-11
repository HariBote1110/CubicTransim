# プレイモード計画（ライト/ノーマル/アドバンスド/リアリスティック）

状態: **PM2 実装済み**（軌間・電化(modes)の静的可否判定、本番経路探索への配線、
高架/地下への配線、Stage B改軌ツール、Stage C UIまで完了。残る follow-up は
軌間・架線の描画差のみ）。2026-08-11 の設計会話を基に作成、同日PM1着手。

## 実装メモ（PM2、2026-08-11）

- `src/types.ts`: `RailGauge`型(`762|1067|1372|1435`)・`DEFAULT_GAUGE`(1067)・
  `TrainPower`型(`'diesel'|'electric'`)を新設。`CellData`に`gauge?`/`electrified?`、
  `TrainData`に`gauge?`/`power?`を追加(すべてoptional・省略時は旧来どおり)。
  高架(uppers)・地下は本セルと軌間を共有する単純化とし、立体交差した別レベルの線路が
  異なる軌間を持つケースはPM2のスコープ外とした。
- `src/sim/gameRules.ts`: `GameRules`へ`extendedGauges: boolean`を追加(基本ラインナップ
  =false、リアリスティックのみtrue)。`playModeOf`もこのフィールドの一致を見るよう拡張。
  `effectiveGauge`/`gaugesCompatible`/`cellAllowsTrain`の3つの純関数を実装。
  いずれも`rules.gauge===false`なら概念が無いものとして無条件でtrue(許可)を返す
  短絡を持ち、「ライトモードは挙動変更ゼロ」を型レベルではなくロジックレベルで保証する。
- `src/sim/construction.ts`: `addConnectionToCell`に`RailBuildOptions`
  (`{gauge?, electrified?}`)を追加。既存の線路セルと軌間が異なる場合はその方向の
  接続ビットを立てない(セル自体は敷設される。「軌間の違う線路は繋がらない」という
  仕様をコネクションレベルで表現)。`applyRailPathDetailed`/`applyRailPath`に
  `railOptions`引数を追加(省略時は空オブジェクト=既存挙動と完全一致)。
- `src/sim/pathfinding.ts`: `RouteQuery`に`rules`/`trainGauge`/`trainPower`を追加。
  BFSの隣接セル探索で`cellAllowsTrain`を呼び、軌間ミスマッチと電化必須セルへの
  気動車以外の進入を拒否する。省略時は`DEFAULT_GAME_RULES`(ライト相当)に短絡。
- `src/sim/economy.ts`: `ELECTRIFICATION_COST_MULTIPLIER = 0.5`(架線設備費、
  線路本体の+50%/セル、値は「あったら楽しい」判断)と`costOfElectrification`を追加。
- `src/sim/buildPreview.ts`: `evaluateBuild`に`railOptions`引数を追加。地平
  (level 0)のrail建設のみ、electrified指定時に架線設備費を上乗せし、
  gauge/electrifiedをそのまま`applyRailPathDetailed`へ橋渡しする(UIに条件を
  書き写さない既存規約どおり)。
- `src/hooks/useGameLogic.ts`: `buyTrain`に`power`引数(既定'diesel')を追加。
  `rules.gauge`が有効なら購入位置(車庫セル)の軌間を新造列車へ自動継承する。
- 永続化: `CellData`/`TrainData`は既存の「Mapを丸ごとentries配列でシリアライズ」に
  乗るため、persistence.ts側の変更は`rules.extendedGauges`のフィールド単位デフォルト
  補完のみで済んだ。**v18への版上げは不要**。

### 追記(PM2続き、2026-08-11): 本番経路探索・高架/地下・Stage B/C

- **simulation.ts本番経路探索への配線**: `SimWorld`に`rules?: GameRules`を追加し、
  `useGameLogic.ts`が既存のrailMap/stations等と同じ`useEffect`同期パターンで
  `gameRules` stateを鏡写しするようにした。`stepTrain`内2箇所の
  `calculateRouteWithStop`呼び出しに`rules`(未設定時は`DEFAULT_GAME_RULES`)・
  `train.gauge`(既定1067)・`train.power`(既定diesel)を渡す。`rules`未設定の
  ワールド(旧セーブ・デバッグシナリオ)は短絡するため挙動は変わらない。
- **高架/地下へのgauge配線**: `applyElevatedPath`/`applyUndergroundPath`に
  `RailBuildOptions`引数を追加。高架・地下は「セル単位で1つの軌間を共有する」
  単純化のもとCellData本体(uppersの外側)へgauge/electrifiedを付ける
  (uppers側のレベル別データは変更しない)。異なる軌間の既存セルへの接続拒否
  (地平と同じロジック)は高架/地下には実装していない(スコープ外のまま)。
  `buildPreview.ts`のelectrified追加コストとapply呼び出しを地平/高架/地下すべてに拡張。
- **Stage B(改軌ツール)**: `construction.ts`に`applyRegaugePath`を実装。既存の
  自線路(`type==='rail'`、駅・車庫・立体交差は対象外)の軌間を一括変換し、既に
  目的軌間のセルは無料でスキップ、経路中に非railセル・列車在線中のセルが1つでも
  あれば全体をno-opにする。電化フラグは変更しない。`economy.ts`に
  `REGAUGE_COST_PER_CELL = RAIL_COST × 0.6`(=60円/セル。撤去+再敷設の100円/セルより
  安い「あったら楽しい」判断)と`costOfRegauge`を追加。`buildPreview.ts`の
  `BuildMode`へ`'regauge'`を追加し、apply結果から実際に変わったセル数を数えて
  コスト・可否を返す(他モードと同じ規約)。
- **Stage C(UI)**: `GameUI.tsx`に線路ツール用の軌間セレクタ(基本: 狭軌/標準軌、
  `rules.extendedGauges`なら特殊狭軌/馬車軌間を追加)と電化/非電化トグルを、
  建設レベル行と同じ`panel()`+`button()`スタイルで追加。改軌ツールボタン
  (`rules.gauge`のときのみ表示、キーボードショートカット'9')と目的軌間セレクタも
  追加。車庫ツールには購入動力(電車/気動車)選択を追加(`rules.electrification!=='none'`
  のときのみ表示。軌間は車庫セルから自動継承、既存のbuyTrainの挙動どおり)。
  `commitPath`(useGameLogic.ts)に`railOptions`/`regaugeTargetGauge`引数を追加し、
  `App.tsx`が対応するReact stateを持って`onCommitPath`/`onBuyTrain`のクロージャで
  橋渡しする(`GameScene.tsx`は`BuildMode`型の変更のみで済み、呼び出しシグネチャは
  無改造)。ブラウザ実機(ノーマルモード)で軌間/電化UI・改軌ボタンの表示条件・
  トグル操作を確認済み。
- **残る follow-up**: 軌間・架線の見た目の違い(描画差)のみ。元のタスク定義どおり
  スコープ外として据え置く。

## 実装メモ（PM1、2026-08-11）

- `src/sim/gameRules.ts` を新設。`GameRules`型（`gauge`/`electrification`/`signalling`の3軸）、
  `PLAY_MODE_PRESETS`（ライト/ノーマル/アドバンスド/リアリスティックの4プリセット。
  signallingはいずれも既定`'s0'`で揃え、独立軸として扱う）、`DEFAULT_GAME_RULES`（ライト相当）、
  日本語表示ラベル`PLAY_MODE_LABELS`、逆引き`playModeOf`（gauge/electrificationの組がどの
  プリセットとも一致しなければ`'custom'`。signallingは無視）を実装。
- セーブスキーマを **v17** へ拡張（`src/sim/persistence.ts`）。`rules?: GameRules`を追加し、
  v16以前（rules欠落）は`DEFAULT_GAME_RULES`として読み込む。モード名ではなくフラグ集合を
  保存する計画どおり。降格禁止ルールはPM1では未着手（rulesを誰も参照しないため実害なし。
  PM2以降でgauge/electrificationを実際の建設判定に使う段階で検討する）。
- `src/hooks/useGameLogic.ts` に `gameRules` state を追加し、`townDensity`/`terrainProfile`と
  同じ経路（save時はserialiseWorldへ渡す、load時はsetGameRules、newGame時は引数で受け取る）
  で配線。`worldRef.current`（SimWorld）には乗せず、React state止まり（既存2値と同じ扱い）。
- `src/App.tsx` の新規ゲームダイアログに「プレイモード」ボタン行を追加（町の密度/地形と同じ
  `themeButton`パターン、既定選択はライト）。選択したプレイモードのプリセットを
  `newGame(halfExtent, townDensity, terrainProfile, PLAY_MODE_PRESETS[selectedPlayMode])`
  として渡す。選択中モードの一行説明を表示。
- PM1のスコープどおり、rulesはセーブ・ロード・UI表示以外のどこからも読まれない
  （construction.ts / pathfinding.ts などの可否判定には未接続）。`npm run test` /
  `npm run build` とも green。PM2で軌間・電化方式(`electrification: 'modes'`)の
  静的可否判定へ接続する。

## 目的

鉄道の複雑な概念（軌間・電化・交直流など）を段階的に開放する4つのプレイモードを導入し、
新規プレイヤーの学習曲線を緩やかにしつつ、上級者には「全部盛り」の深さを提供する。

## モード定義

| モード | 追加される概念 |
| :--- | :--- |
| ライト | 何も追加しない（現行仕様そのまま。軌間・電圧・交直の概念なし） |
| ノーマル | 軌間の選択、電化方式の選択（直流のみの単純な扱い） |
| アドバンスド | ノーマル + 交直流（交流電化、交直デッドセクション、交直流車） |
| リアリスティック | 鉄道のややこしい部分全部盛り。**特に電化まわりを全部盛りにする**（下記） |

- 信号方式（閉塞方式など）は**モードとは独立した別軸の選択**とする。
  「電化は簡単でいいが信号は本格的に」という層を取りこぼさないため。
- 旧称「ハードモード」は「リアリスティックモード」へ改名済み（名称のみ、2026-08-11決定）。

## 実装アーキテクチャ: モードは「ルールフラグのプリセット」

モード名を直接分岐条件にしない。内部的にはルールフラグ集合を持ち、4モードはその既定値セットとする。

```ts
interface GameRules {
  gauge: boolean;                                          // 軌間の概念の有無
  electrification: 'none' | 'modes' | 'boundaries' | 'feeding'; // 電化の段階
  signalling: SignallingRules;                             // 別軸（モード非依存）
  // 将来の拡張はここへ追加
}
```

- ライト = `{gauge: false, electrification: 'none'}`
- ノーマル = `{gauge: true, electrification: 'modes'}`
- アドバンスド = `{gauge: true, electrification: 'boundaries'}`
- リアリスティック = `{gauge: true, electrification: 'feeding'}`

利点:
1. 信号別選択が自然に収まる
2. 将来「カスタムモード」がフラグの直接編集だけで手に入る
3. sim層のテストをモード名でなくフラグ単位で書ける

### セーブデータ

- **モード名ではなくフラグ集合を保存する**（現行 v16 スキーマへの追記）。
  後からモード定義（既定値セット）を変えても既存セーブが壊れない。
- 既存セーブ（フラグ無し）はライト相当のフラグで読み込む。
- モードの昇格（ライト→ノーマル等）のみ許可し、降格は不可とする。
  昇格規則の例: ライトのセーブをノーマルで開くと全線が標準軌・非電化扱いになる。
  降格は情報が落ちるため定義しない。

## 電化の「全部盛り」の内訳（リアリスティックの本丸）

電化のややこしさは4階層に整理できる。要素同士が
「変電所→き電区分→デッドセクション→車両の対応電源」という一本の因果で繋がるため、
ゲームメカニクスとして破綻しにくい。

### 1. 方式の選択（`electrification: 'modes'`、ノーマルから）
- 非電化 / 直流(600V・750V・1500V) / 交流(20kV 50Hz・60Hz、25kV)
- 架線 vs 第三軌条。第三軌条は地下・都市向けで、踏切と相性が悪い・雪に弱い等の制約が個性になる

### 2. 境界の処理（`electrification: 'boundaries'`、アドバンスドから）
- 交直デッドセクション: 惰行で通過、通過速度の下限、通過できるのは交直流車のみ
- 異周波数境界（50/60Hz）
- 直流同士でも電圧が違えば直通不可、または複電圧車が必要

### 3. 給電インフラ（`electrification: 'feeding'`、リアリスティック固有の目玉）
- 変電所の設置とき電区間: 変電所から一定距離しか給電できない
- 同一き電区間の在線数が容量を超えると電圧降下で加速力が落ちる
  （physics.ts の加速モデルに係数として載せる）
- 直流は変電所間隔が短い（数km）・交流は長い（数十km）→
  「初期費用は交流が安いが車両が高い」という実物どおりのトレードオフが自然に出る

### 4. 車両側
- 対応電源: 直流車 / 交流車 / 交直流車 / 気動車 / バッテリー・デュアルモード
- 交直流車・複電圧車は高価、という価格差で路線計画に効かせる

### やりすぎ警戒ライン
- 電圧降下の連続シミュレーション（回路計算）は**やらない**。
  「同一き電区間の在線数が容量を超えたら加速率に一律ペナルティ」程度の離散近似で、
  プレイヤーに見える因果は十分成立し、sim層のテストも書きやすい。

## 実装フェーズ（案）

| フェーズ | 内容 | リスク |
| :--- | :--- | :--- |
| PM1 | `GameRules` 型・フラグ集合の骨組み、セーブ拡張、モード選択UI。**現行仕様＝ライトと定義するだけ**で挙動変更なし | 小 |
| PM2 | 軌間 + 電化方式（modes）。建設時の方式選択、pathfinding/建設可否の静的述語（通れる/通れない） | 中 |
| PM3 | 境界（boundaries）。デッドセクション、車両の対応電源、惰行通過 | 中 |
| PM4 | き電（feeding）。変電所の建設物、き電区間の索引、容量超過ペナルティ | 大 |
| PM5 | 信号方式の別軸選択（詳細は別メモで設計） | — |

- PM1 から着手する。挙動変更ゼロでモードの器だけ入るため、リスクが最小。
- 1・2階層（modes/boundaries）は静的な可否判定（construction.ts / pathfinding.ts の述語追加）で済む。
  3階層（feeding）だけが運行密度と絡む動的な問題で、ダイヤを組むゲーム性と直結する。
- リアリスティック自体も内部的には段階リリースとする（全部を一度にやらない）。

## リアリスティックの追加候補: 軌道（レール種別と対荷重）

電化に続く「全部盛り」候補（2026-08-11 追記）。優先度は電化より下だが、
建設時の選択→速度/荷重の制約→保線コスト、という因果が電化と同型なので実装コストは読みやすい。

- **レール種別（何キロレール）**: 37kg / 50kgN / 60kg など。重いレールほど
  高価だが許容速度と許容軸重が上がり、摩耗（保線費）が減る
- **対荷重（軸重制限）**: 線路ごとの許容軸重を超える車両は入線不可
  （建設可否と同じ静的述語で判定できる。貨物や機関車を導入する際に効いてくる）
- 表現は「同一き電区間の容量ペナルティ」と同じく離散近似でよい。
  軌道破壊の連続シミュレーションはやらない

## 遠い将来の夢（絵空事メモ）

3D自前レンダラーであることを活かした長期候補。**当面のスコープ外**だが、
アーキテクチャ判断で扉を閉ざさないよう記録しておく。

- **乗客視点**: 列車に「乗って」車窓を眺めるカメラ。現行カメラは俯瞰直交投影
  （cameraState.ts）なので、透視投影カメラのモードを wgpu レンダラーに足す必要がある。
  `renderPos`/`trackPath.ts` の走行線上にカメラを置くだけなので sim 層は無改造で済む見込み
- **運転モード**: プレイヤーがマスコンを握って1列車を手動運転する。
  physics.ts の加速モデル・制動曲線がそのまま車両応答に使えるうえ、
  信号計画（signalling-plan.md）の ATS-P/ATC が「プレイヤーを守る装置」として
  初めて肌で分かるようになる——保安装置システムとの相性が非常に良い

## 軌間の決定事項（2026-08-11 決定）

- ノーマル/アドバンスド: **狭軌(1067mm)と標準軌(1435mm)の2種のみ**
- リアリスティック: 拡張ラインナップ（特殊狭軌762mm・馬車軌間1372mmを追加した4種）
- **改軌工事あり**（既存線路の軌間を費用を払って変換するツール。「あったら楽しい」判断）
- ルールフラグとしては `extendedGauges: boolean`（リアリスティックのみ true）で表現し、
  モード名では分岐しない原則を維持する

## 未決定事項

- き電区間の容量・変電所間隔の具体値（ゲームスケール上のセル数換算）
- 信号方式の選択肢の中身（PM5 の設計時に別メモを起こす）
- モード選択UIの置き場所（新規ゲームダイアログ内を想定）
- リアリスティックの電化以外の候補（建築限界・勾配と粘着・保線など）は
  電化全部盛りの完成後に改めて優先順位を付ける
