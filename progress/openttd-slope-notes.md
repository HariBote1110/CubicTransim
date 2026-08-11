# OpenTTD 斜面(Slope)・傾斜建設ソース精読ノート

OpenTTD 実ソースコードの精読による挙動仕様の抽出。対象コミット: `OpenTTD/OpenTTD` master ブランチ
(2026-08-07 取得、`map_scale_research/external/OpenTTD` に shallow clone 済み・gitignore 対象)。

読者: CubicTransim P7(標高上の建設: 勾配レール・段丘上の線路・駅・基礎)の実装者。openttd-source-notes.md
と同じ方針で、C++の逐語訳ではなく再実装可能な粒度の挙動ルールとして記述する。CubicTransim は既に
コーナー格子(`heights`/将来の `terrainField.cornerHeightAt`)を一次データとして持つ設計
(`progress/16k-map-architecture.md` 追記「コーナー格子を一次データにする」)なので、以下の多くは
そのままの対応関係で読める。

---

## A. 標高・斜面のデータモデル

### A-1. 挙動仕様

**TileHeight — 「北コーナー」だけを保存する**
- `tile_map.h` の `TileHeight(Tile tile)` はそのタイルの**北コーナー(N)の標高**を返す。マップ配列に
  タイルごと1バイトで保存されている実体はこれだけ。西・東・南コーナーの標高は「隣接タイルの北コーナー」
  として間接的に読む(`tile_map.cpp` の `GetTileSlopeZ` 参照)。
- つまり OpenTTD は「タイル数」個の格納箇所で「コーナー数」個の値を表現している(コーナー格子と1:1で、
  タイルの4隅は隣接タイル同士で共有される)。CubicTransim の `heights: Map<string, number>`(コーナー
  キー)は既にこの発想と同じ形をしている。
- `MAX_TILE_HEIGHT = 255`(1バイトの理論上限)。実際の上限はゲーム設定 `construction.map_height_limit`
  (既定値0=自動、`MIN_MAP_HEIGHT_LIMIT=15`〜`MAX_MAP_HEIGHT_LIMIT=255`)で絞る。

**Slope enum とコーナービット (`slope_type.h`)**
```
Corner: W, S, E, N (+ End, Invalid)
Slope:  SLOPE_FLAT=0x00
        SLOPE_W=0x01, SLOPE_S=0x02, SLOPE_E=0x04, SLOPE_N=0x08   (単独コーナー隆起)
        SLOPE_STEEP=0x10                                          (急斜面フラグ)
        SLOPE_NW/SW/SE/NE = 隣接2コーナー隆起(緩傾斜、1方向へ向く坂)
        SLOPE_EW/SLOPE_NS = 対角2コーナー隆起(尾根/谷、これ自体は「傾斜レール」を許さない特殊系)
        SLOPE_ELEVATED = N|E|S|W (4隅とも同じ高さだけ全体が1段上=見た目は平坦)
        SLOPE_NWS/WSE/SEN/ENW = 3コーナー隆起(1コーナーだけ低い)
        SLOPE_STEEP_W/S/E/N = SLOPE_STEEP | 上記3コーナー系(急斜面、最高点はその系の"欠けている"対角)
```
- 5bit で 19種類の非ハーフタイル形状を表現(`NUM_SLOPES=19`)。ハーフタイル(非連続な部分基礎)は別途
  上位3bitで表現するが、CubicTransim には当面不要(後述)。

**4隅の標高からタイル形状を導出する式 — `GetTileSlopeGivenHeight`(`tile_map.cpp`)**
```cpp
hmin = min(hN, hW, hE, hS);
hmax = max(hN, hW, hE, hS);
r = FLAT;
if (hN != hmin) r |= SLOPE_N;
if (hW != hmin) r |= SLOPE_W;
if (hE != hmin) r |= SLOPE_E;
if (hS != hmin) r |= SLOPE_S;
if (hmax - hmin == 2) r |= SLOPE_STEEP;
return (r, hmin);  // hmin がそのタイルの「基準高さ(z)」
```
- **タイル形状は「4隅のうち最も低い点からの相対的な隆起パターン」として決まる。** タイルの基準z(描画・
  当たり判定の原点)は常に最低コーナーの高さ。
- `hmax - hmin` は 0(平坦)・1(緩斜面)・2(急斜面)のいずれかしかあり得ない、という前提(下記の隣接
  制約が保証する)。3以上は起こらない設計。

**隣接コーナー段差の制約(1-Lipschitz 相当)**
- ソースコード中に明示的な「隣接コーナー段差は1以下」というグローバル不変条件チェック関数は無いが、
  `GetTileSlopeGivenHeight` のコメント(「タイルは隙間なく接続しなければならないので、どのコーナーと
  hmin との差も0・1・2のいずれかで、差2のコーナーは最大1個」)がそれを前提としている。実際にこの
  不変条件を**作る側**の保証は地形生成(`landscape.cpp` の `CreateDesertOrRainForest` 等、生成アルゴリズム
  依存)と `TerraformTileHeight` の再帰的な段差復元(下記B)の2箇所。
- CubicTransim の `terrainField.ts` の 1-Lipschitz 構成保証はこの前提を先回りして満たす設計であり、方向性は
  完全に一致している。**ただし OpenTTD は「急斜面(段差2)」を正式サポートする**点が CubicTransim の現行
  制約(段差1以下のみ、急斜面なし)と異なる。急斜面を採らない場合、`SLOPE_STEEP_*` 系19種のうち4種類
  (STEEP_W/S/E/N)と、それに付随する Foundation(SteepLower/SteepBoth)がまるごと不要になり、実装が
  大幅に単純化される(後述の「示唆」参照)。

**傾斜(インクライン)の定義 — `IsInclinedSlope` / `GetInclinedSlopeDirection`(`slope_func.h`)**
- 「傾斜地」として扱われるのは隣接2コーナー隆起の4種のみ: `SLOPE_NW/SW/SE/NE`。これが「1段の坂」の形。
- 対角2コーナー隆起(`SLOPE_EW`/`SLOPE_NS`、尾根・谷型)と3コーナー隆起・急斜面は「傾斜地」ではなく、
  レールを敷くには基礎(Foundation)で強制的にならす必要がある(後述)。

**MaxZ / MinZ ヘルパー**
- `GetTileZ(tile)` = 4隅の最小値(タイルの基準z、`hmin` と同じ)。
- `GetTileMaxZ(tile)` = 4隅の最大値。
- `GetSlopeMaxZ(slope)` = `slope==FLAT ? 0 : (IsSteepSlope(slope) ? 2 : 1)`(基準zからの相対最高点)。

### A-2. 参照ファイル/関数
- `slope_type.h`: `enum Corner`, `enum Slope`(全19種+ハーフタイル), `enum class Foundation`
- `slope_func.h`: `IsSteepSlope`, `IsInclinedSlope`, `GetInclinedSlopeDirection`, `InclinedSlope`,
  `GetHighestSlopeCorner`, `IsSlopeWithOneCornerRaised`, `IsSlopeWithThreeCornersRaised`,
  `ComplementSlope`, `SteepSlope`, `GetSlopeMaxZ`
- `tile_map.h`: `TileHeight`, `SetTileHeight`, `GetTileSlope`(inline, `GetTileSlopeZ` のSlope部分だけ)
- `tile_map.cpp`: `GetTileSlopeGivenHeight`(static)、`GetTileSlopeZ`、`GetTilePixelSlopeOutsideMap`、
  `IsTileFlat`、`GetTileZ`、`GetTileMaxZ`
- `table/settings/world_settings.ini`: `construction.map_height_limit`(既定0=自動)、
  `construction.build_on_slopes`(既定true)
- `tile_type.h`: `MAX_TILE_HEIGHT=255`, `MIN_MAP_HEIGHT_LIMIT=15`, `MAX_MAP_HEIGHT_LIMIT=255`

### A-3. 簡易ゲームへの適用メモ
- CubicTransim のコーナー格子(`cornerHeightAt(x,z)`)は OpenTTD の「北コーナー保存+隣接タイルから残り
  3隅を読む」という間接参照方式より素直(コーナー自体を直接キーで持てる)。移植時は
  `GetTileSlopeGivenHeight` の4値min/max判定ロジックだけをそのまま使えばよく、保存形式の工夫は不要。
- 急斜面(段差2)を当面スコープ外にするなら、`Slope` は実質「4隅のうちどれが高いか」の4bitだけで足り、
  19種のうち急斜面4種とハーフタイル系を除いた **11種類の非ハーフタイル・非急斜面 Slope**
  (FLAT/N/E/S/W/NE/SE/SW/NW/EW/NS) だけを実装すればよい。

---

## B. 地形編集(TerraformLand / LevelLand)

### B-1. 挙動仕様

**単一コーナーの持ち上げ/切り下げ — `TerraformTileHeight`(`terraform_cmd.cpp`)の再帰**
```cpp
TerraformTileHeight(state, tile, height):
    if height < 0: エラー(既に海面)
    if height > map_height_limit: エラー(高すぎる)
    if height == 現在の(暫定)高さ: エラー(効果なし)
    if 端(freeform_edges無効時、外周1マス): エラー(地図端に近すぎる)

    このタイル北コーナーの新高さを height として暫定記録
    コスト += Price::Terraform

    for 4つの対角方向(NE/SE/SW/NW)の隣接コーナー(タイル)について:
        r = 隣接コーナーの(暫定)現在高さ
        height_diff = height - r
        if abs(height_diff) > 1:
            # 段差を1に収める分だけ隣接コーナーも巻き込んで再帰
            height_diff += (height_diff < 0 ? 1 : -1)
            再帰: TerraformTileHeight(state, 隣接コーナー, r + height_diff)
            コスト += 再帰コスト
    return 合計コスト
```
- **「段差1以下」制約を、変更対象コーナーから四方に再帰伝播させて自動復元する。** CubicTransim の
  `terrainEdit.ts` の方向つきBFS伝播と本質的に同じアイデア(OpenTTD は「四方向への再帰」、CubicTransim
  は「矩形境界からのBFS」という探索形状の違いはあるが、目的と結果は同一)。
- 1回の `TerraformLand` コマンドは、ドラッグした矩形選択の**北コーナー1点ずつ**に対して
  `TerraformTileHeight` を呼ぶ(`CmdTerraformLand` が選択矩形のW/S/E/N隅コーナーを順に処理)。実際の
  「面」としての盛土/切土(`CmdLevelLand`)は、対象矩形の各タイルについて「現在高さ→目標高さまで
  1段ずつ `CmdTerraformLand(N隅のみ)` を繰り返す」形で実現している。

**コスト**: 変更されたコーナー1個あたり `Price::Terraform` の定額。再帰で巻き込まれた分もすべて加算
される(CubicTransim の `TERRAIN_EDIT_COST × 変化セル数` という「伝播分も課金」の方針と一致)。

**編集をブロックする要素(実行前チェック)**
- 橋の下: `direction==+1`(持ち上げ)で橋げたに地形が接触する場合、`direction==-1`(切り下げ)で橋が
  `max_bridge_height` を超えて高くなりすぎる場合はエラー。
- トンネルの上: 切り下げ方向で `IsTunnelInWay(t, z_min)` ならエラー(掘削がトンネルを破壊する)。
- 地図端: `freeform_edges` 無効時は外周1マス以内の編集を拒否。
- 各タイルの `terraform_tile_proc`(タイル種別ごとの実装、線路・建物等がある場合は個別ルールで拒否
  またはオブジェクトの自動撤去)。**線路タイル自体は、変形後も既存の Track/Slope 組み合わせが有効な
  範囲なら terraform を許可する**(=線路の上に盛土すると自動的にレールの形・基礎が追従して変わり得る。
  これは CubicTransim の「線路が絡む編集は同一参照のno-op」という現行の安全側ルールより踏み込んでいる)。
- 会社の `terraform_limit`(1tickあたりの編集量上限、レートリミット)。CubicTransimには対応物なし
  (不要と判断してよい)。

**面編集(`CmdLevelLand`)の形**: 選択矩形(矩形選択 or 対角選択)を走査し、各タイルについて
「目標高さに達するまで `TerraformLand`(北コーナーのみ)を1段ずつ繰り返す」。1段ごとに毎回コマンドを
実行するため、複数段の編集でも常に「段差1以下」制約を満たしたまま進行する(一気に3段上げることはない)。

### B-2. 参照ファイル/関数
- `terraform_cmd.cpp`: `TerraformGetHeightOfTile`(static)、`TerraformSetHeightOfTile`(static)、
  `TerraformAddDirtyTileAround`(static)、`TerraformTileHeight`(static, 再帰本体)、
  `CmdTerraformLand`(コマンド、矩形の4隅コーナーを呼ぶ)、`CmdLevelLand`(面編集、1段ずつのループ)
- `table/settings/world_settings.ini`: `construction.max_bridge_height`

### B-3. 簡易ゲームへの適用メモ
- CubicTransim の `applyTerrainEdit`(矩形選択を±1段+BFS伝播で段差1復元)は、OpenTTDの「単一コーナー
  操作+四方向再帰」を「矩形全体+BFS」に一般化した設計として理解でき、方向性の妥当性が裏付けられる。
- OpenTTDが「線路がある場所でも terraform 自体は許可し、結果的な Slope/Foundation の組み合わせが
  無効ならその時点で失敗させる」設計なのに対し、CubicTransimは「線路が絡む編集は事前に一律no-op」で
  安全側に倒している。P7で傾斜レールを導入するなら、terraform 側を「結果の Foundation が有効かどうか」
  で判定する方式に寄せるかどうかは設計判断(実装は複雑化するが、山を後から均して線路を通す、といった
  自然な操作性が得られる)。
- コスト・トンネル/橋との衝突チェックの考え方(切り下げでトンネル破壊・持ち上げで橋に接触)は、
  CubicTransim にも将来トンネル/高架と地形編集の相互作用チェックとしてそのまま輸入できる。

---

## C. 基礎(Foundation) — 斜面の上に「平ら」または「一方向の傾斜」を作る仕組み

### C-1. 挙動仕様

**Foundation enum(`slope_type.h`)**
```
None            : 基礎なし、地形そのまま
Leveled         : タイル全体を水平に均す基礎(4隅とも最高点の高さに揃える)
InclinedX       : X軸(NE-SW)に沿った一様な傾斜基礎
InclinedY       : Y軸(NW-SE)に沿った一様な傾斜基礎
SteepLower      : 急斜面の低い側だけ持ち上げて緩斜面相当にする基礎(急斜面専用)
SteepBoth       : 急斜面で低い側を持ち上げ、かつ高い側ハーフタイルも均す(急斜面専用、ハーフタイル)
HalfTileW/S/E/N : 指定コーナー側だけ非連続に平らにする「ハーフタイル基礎」
RailW/S/E/N     : 単一の水平/垂直レール専用の「ジグザグ防止」特殊基礎(非レベル化)
```
- **基礎は「実際の地形メッシュを変えず、その上に構造物(線路・建物・道路)が乗る面だけを局所的に
  平らまたは一様傾斜にする」仕組み。** 地形本体(4隅コーナー標高)は変更されない。描画時に
  `ApplyFoundationToSlope(f, slope)` を通して「構造物から見た実効Slope」を再計算する。

**基礎の必要有無・種類の決定 — `ApplyFoundationToSlope`(`landscape.cpp`)**
```cpp
if f == None: 変化なし、dz=0
if f == Leveled:
    dz = 1 + (急斜面なら+1)   # 構造物の基準zがdzだけ持ち上がる
    slope = FLAT
if f がハーフタイル系(SteepBoth以外):
    slope にハーフタイルフラグを追加、dz=0
if f が RailW/S/E/N(特殊ジグザグ防止):
    slope = 「指定コーナーの対角3コーナー隆起」相当に変換、dz=0
それ以外(InclinedX/Y, SteepLower, SteepBoth):
    dz = 急斜面なら1、そうでなければ0
    highest = そのタイルの最高コーナー
    InclinedX → SLOPE_SW(highest∈{W,S}のとき) or SLOPE_NE
    InclinedY → SLOPE_SE(highest∈{S,E}のとき) or SLOPE_NW
    SteepLower → 最高コーナーだけ隆起した1コーナー系(=緩斜面扱いになる)
    SteepBoth  → 同上+ハーフタイル
```
- 基礎の**コスト**は `Price::BuildFoundation`(基礎が新規に必要になった/変わった場合のみ課金、
  `CheckRailSlope` 参照)。

### C-2. 参照ファイル/関数
- `slope_type.h`: `enum class Foundation`
- `slope_func.h`: `IsFoundation`, `IsLeveledFoundation`, `IsInclinedFoundation`,
  `IsNonContinuousFoundation`, `FlatteningFoundation`, `InclinedFoundation`, `HalftileFoundation`,
  `SpecialRailFoundation`
- `landscape.cpp`: `ApplyFoundationToSlope`、`GetPartialPixelZ`(タイル内座標→実高さ、描画・当たり判定用)

### C-3. 簡易ゲームへの適用メモ
- CubicTransim の描画は「セル内 pos 0〜1 のスムーズステップ曲線でレール高さを補間する」
  (`trackPath.ts`/`rampHeightAtPos`)方式であり、OpenTTD の「離散的な Foundation 種別を選んでタイル
  形状そのものを変える」方式とは設計思想が異なる。**Foundation を丸ごと輸入するのではなく、
  「このセルにこの Track 方向を敷けるか(=有効な傾斜方向かどうか)」の判定ロジックだけを借りるのが
  現実的**(下記Dのテーブルがまさにそれ)。

---

## D. 線路と斜面 — どの Track が どの Slope で建設可能か

### D-1. 挙動仕様

**非急斜面での「基礎なしで敷ける」Track の対応表 — `_valid_tracks_without_foundation`(`rail_cmd.cpp`)**

Slope(非急斜面11種、FLAT/N/E/S/W/NE/SE/SW/NW/EW/NS の順、テーブルの並び順に対応)ごとに、
**基礎なしで直接敷ける唯一の Track の向き**が決まっている:
```
FLAT           : すべて可(TRACK_BIT_ALL)
1コーナー隆起(W): Track::Right(=対角の平ら側)のみ基礎なし
1コーナー隆起(S): Track::Upper のみ
1コーナー隆起(E): Track::Left のみ
1コーナー隆起(N): Track::Lower のみ
隣接2コーナー(SLOPE_SW,傾斜地): Track::Y(=傾斜方向に沿った斜めレール)のみ、これが「上り坂」の基本形
隣接2コーナー(SLOPE_SE)      : Track::Lower のみ
隣接2コーナー(SLOPE_NW)      : Track::Left のみ
隣接2コーナー(SLOPE_NE,傾斜地): Track::X のみ
対角2コーナー(EW尾根/谷)      : {} (基礎なしでは何も敷けない)
対角2コーナー(NS尾根/谷)      : {} (同上)
```
- **傾斜地(SLOPE_NE/SE/SW/NW)では、その傾斜方向に一致する斜めTrack(X or Y)だけが基礎なしで敷ける。**
  これがいわゆる「勾配レール」そのもの。
- 単純な1コーナー隆起(N/E/S/W)では、隆起コーナーの対角にある水平/垂直Trackだけが基礎なし可(実質
  平坦扱いできる位置)。

**基礎ありなら敷ける範囲を広げる表 — `_valid_tracks_on_leveled_foundation`**: 上記より広い集合
(例えば1コーナー隆起でも Y字カーブや十字は Leveled 基礎で許可、など)。**「Leveled(水平化)基礎さえ
使えば大抵の Track はどんな非急斜面にも置ける」**という基本方針。

**中核関数 `GetRailFoundation(Slope tileh, TrackBits bits)` の分岐**
1. 急斜面(`SLOPE_STEEP`)の場合:
   - Track::X または Track::Y(斜めの単線)だけなら `InclinedX`/`InclinedY` 基礎で敷ける(急斜面の傾斜が
     そのまま2段の坂になる)。
   - 最高コーナー側のTrackだけなら `HalftileFoundation`(ハーフタイル基礎、上半分だけ平ら)。
   - 最高コーナー側と重なる(が完全一致しない)組み合わせは `Foundation::Invalid`(敷けない)。
   - それ以外(低い側だけ、または低い側+高い側両方)は `SteepLower`/`SteepBoth`。
2. 非急斜面の場合:
   - 基礎なしで十分なら `Foundation::None`。
   - `_valid_tracks_on_leveled_foundation` に収まるなら、単一の水平/垂直/斜めTrackごとに個別分岐:
     - 十字(HORZ)や縦(VERT)の単線は、特定のSlope(N/S または W/E の単独隆起)なら `HalftileFoundation`、
       それ以外は `Leveled`。
     - 斜め単線(X/Y)は、その斜面が「1コーナー隆起」なら `InclinedX`/`InclinedY`(=そのまま坂として
       乗る、基礎不要に近い扱い)、そうでなければ `Leveled`。
     - **単一の直線Track(左/右/上/下)が、3コーナー隆起の斜面に乗る場合は無条件 `Leveled`。**
     - **単一の直線Trackが、その対角コーナーだけ低い(=対称的にへこんでいる)場合は
       `HalftileFoundation`(そのコーナー側だけ持ち上げ、逆側は地形なりの傾斜を残す)。**
     - それ以外は `SpecialRailFoundation`(「ジグザグ防止基礎」— 単独の水平/垂直Trackが中途半端な
       傾斜地に乗るとき、線路の下だけ土台を作ってガタつきを消す特殊ケース)。
   - Trackの組み合わせが基礎レベル化しても許容範囲を超える場合は `Foundation::Invalid`(敷設不可、
     `STR_ERROR_LAND_SLOPED_IN_WRONG_DIRECTION`)。

**建設可否・コストの最終判定 — `CheckRailSlope`(`rail_cmd.cpp`)**
```cpp
f_new = GetRailFoundation(tileh, 新規+既存のTrackBits);
if f_new == Invalid: エラー(向きが違う)
if f_new != None && !build_on_slopes設定: エラー(斜面建設オフなら基礎必須の建設は拒否)
f_old = GetRailFoundation(tileh, 既存Trackのみ);
コスト = (f_new != f_old) ? Price::BuildFoundation : 0;   # 基礎が新規/変化したときだけ課金
```

**列車の高さ(Z)算出 — `GetSlopePixelZ(x, y, ground_vehicle)`**
- タイル種別ごとの `get_slope_pixel_z_proc`(レールは `GetSlopePixelZ_Rail`)にディスパッチ。
- `ground_vehicle=true` を渡すと「地上車両として実際に乗る高さ」(=基礎込みの実効Slopeに沿った高さ)、
  `false` だと「地形そのものの高さ」を返す、という使い分け。列車のZ座標更新
  (`GroundVehicle::UpdateZPositionAndInclination`、`ground_vehicle.hpp`)はタイル中心と現在座標の高さ差
  から昇り/降りフラグ(`GoingUp`/`GoingDown`)を立てる。

**速度への影響 — `GetSlopeResistance()`(`ground_vehicle.hpp`、Realisticモデルのみ)**
- 登坂中の車両ごとに `cached_slope_resistance`(=重量×`train_slope_steepness`設定×100、
  既定値3=3%)を加算、降坂中は減算。**Originalモデルでは坂による速度変化は
  `AffectSpeedByZChange`(`_accel_slowdown[].z_up/z_down`定数テーブル)で別処理**
  (openttd-source-notes.md のC節で既出)。`train_slope_steepness` の既定値が **3**(%)であることを本調査
  で確認(前回ノートでは未確認と記載していた項目)。

**踏切建設可能なSlope — `VALID_LEVEL_CROSSING_SLOPES`(`slope_type.h`)**
- `SLOPE_SEN, SLOPE_ENW, SLOPE_NWS, SLOPE_NS, SLOPE_WSE, SLOPE_EW, SLOPE_FLAT` の7種のみ。つまり
  **3コーナー隆起・対角2コーナー隆起・平坦の組み合わせでのみ踏切が作れ、単純な1コーナー隆起や傾斜地
  (2隣接コーナー)には作れない。**

### D-2. 参照ファイル/関数
- `rail_cmd.cpp`: `_valid_tracks_without_foundation`, `_valid_tracks_on_leveled_foundation`,
  `GetRailFoundation`, `CheckRailSlope`(static), `CmdBuildSingleRail`, `GetFoundation_Rail`(static,
  描画用ディスパッチ)
- `landscape.cpp`: `GetSlopePixelZ`, `GetSlopePixelZOutsideMap`
- `ground_vehicle.hpp`: `GroundVehicle::GetSlopeResistance`, `UpdateZPositionAndInclination`
- `slope_type.h`: `VALID_LEVEL_CROSSING_SLOPES`
- `table/settings/game_settings.ini`: `vehicle.train_slope_steepness`(既定値3, 範囲0〜10)

### D-3. 簡易ゲームへの適用メモ
- CubicTransim が急斜面を採らない場合、この節の複雑さの大半(急斜面のSteepLower/SteepBoth分岐、
  ハーフタイル系)は丸ごと不要になる。**必要なのは実質「1コーナー隆起」と「傾斜地(隣接2コーナー
  隆起)」の2パターンだけ**:
  - 傾斜地(隣接2コーナー隆起) → その傾斜方向に沿った斜めTrack(1本)だけを許可、基礎不要=既存の
    `rampHeightAtPos` の坂表現がそのまま使える
  - 1コーナー隆起 → 対角側の直線Trackのみ基礎不要で許可、それ以外は「Leveled相当(セル全体をその
    コーナーの高さで水平化)」で敷設可・コスト加算、という単純な2択に落とせる
  - 対角2コーナー隆起(尾根/谷)・3コーナー隆起は「Leveled必須」で統一してよい(急斜面を採らない前提
    なら、この2系統は基礎前提の少数ケースとして扱って十分)
- `train_slope_steepness` 既定値3%は、CubicTransim の物理モデルに勾配抵抗を足す場合の参考値として
  そのまま使える(`sim/physics.ts` の速度計算に、登坂時 `speedFactor -= steepness`、降坂時
  `speedFactor += steepness` 程度の単純化案)。

---

## E. 駅・車庫の斜面建設ルール

### E-1. 挙動仕様

**`CheckBuildableTile`(`station_cmd.cpp`) — 駅タイル1枚ごとの判定**
```cpp
if (!allow_steep && 急斜面) : エラー(平地が必要)
if (!build_on_slopes設定 && タイルが非FLAT) : エラー(平地が必要)

flat_z = タイル基準z + そのSlopeの最高点相対高さ;
if (Slopeが非FLAT):
    for 4方向 dir:
        if invalid_dirs に dir が含まれ、かつ CanBuildDepotByTileh(dir, slope) が false:
            エラー(平地が必要)
    コスト += Price::BuildFoundation
if (allowed_z が未確定(先頭タイル)): allowed_z = flat_z
elif (allowed_z != flat_z): エラー(平地が必要)  # 複数タイルの駅は「均した後の高さ」が全タイルで一致必須
```
- **駅は非平坦地にも建設できるが、傾斜方向が「駅の向いている方向(invalid_dirs)」と衝突しないこと、
  かつプラットフォーム全タイルが基礎込みで同じ高さ(flat_z)に揃うことが条件。** 個々のタイルは
  `Leveled` 相当の基礎で水平化される(=駅の下は必ず水平)。傾斜そのものに沿った「坂の途中の駅」は
  作れない。

**車庫の斜面判定 — `CanBuildDepotByTileh(direction, tileh)`(`depot_func.h`)**
```cpp
entrance_corners = InclinedSlope(direction);  // 出口方向に対応する2コーナー
if 急斜面: 両方のコーナーが隆起していることが必須(=出口側が完全に高い側)
else:      どちらか一方でも隆起していれば可
```
- 車庫(および駅の invalid_dirs 判定)は「出口が向く方向の地面が、入口側より高すぎない(=出口へ向けて
  下るか水平)」ことを保証する形。急斜面ではより厳しい(両コーナー必須)。

### E-2. 参照ファイル/関数
- `station_cmd.cpp`: `CheckBuildableTile`
- `depot_func.h`: `CanBuildDepotByTileh`
- `autoslope.h`: `((tileh_new == SLOPE_FLAT) || CanBuildDepotByTileh(entrance, tileh_new))`
  (テラフォーム後も車庫の出口が有効であり続けるかの再チェックに同じ関数を再利用)

### E-3. 簡易ゲームへの適用メモ
- CubicTransim の駅は「セル単位のホーム、軸(ns/ew/cross)固定」という設計なので、そのまま
  「駅セル全部が同一の実効水平高さになる基礎ルール」として `CheckBuildableTile` の考え方を輸入できる。
  複数セルにまたがる駅で高さが食い違うケースだけ弾けば十分(=段丘の上に駅を置くこと自体は許可、
  ただし駅の下は必ず水平になる)。
- 車庫は既存のとおり「地平の平地限定」で当面据え置き、段丘対応は後回しでよい(OpenTTD でも車庫の
  斜面対応は駅より単純な「出口方向1つだけ見る」判定であり、優先度は低い)。

---

## F. トンネル・橋と斜面の関係(簡略、CubicTransim は独自トンネル体系のため参考程度)

### F-1. 挙動仕様

**トンネル坑口の必須条件 — `CmdBuildTunnel`(`tunnelbridge_cmd.cpp`)**
- 起点タイルの Slope が `GetInclinedSlopeDirection` で有効な傾斜地(隣接2コーナー隆起の4種)でなければ
  「トンネルに適さない地形」エラー。**つまりOpenTTDのトンネルは必ず「坂の途中」から掘り始まる**
  (CubicTransimの「山に埋もれた坑口」方式とは前提が異なる)。
- 終点タイルは、掘り進めて `start_z == end_z` になった最初のタイルで確定し、その Slope が
  始点の**補完Slope**(`ComplementSlope`、山の反対側から見て同じ形になる傾斜)であることを要求。
  一致しなければ地形改変(強制terraform)で合わせる。
- 建設コストは距離に応じて逓増(`tiles_coef` を25本ごとに1段階緩和する調整つき)。

**橋の坂 — `HasBridgeFlatRamp(Slope, Axis)`**: 橋の取り付き部が「平ら」か「坂」かをSlopeとAxisから
判定するヘルパー(詳細未読、名前と用途から推定)。橋の始点・終点も基本的に傾斜地または平地であることが
前提。

### F-2. 参照ファイル/関数
- `tunnelbridge_cmd.cpp`: `CmdBuildTunnel`, `HasBridgeFlatRamp`, `CheckBridgeSlope`

### F-3. 簡易ゲームへの適用メモ
- CubicTransim は「山の内部判定(4隅標高がlevel以上)」という独自方式のトンネルを既に持っており
  (`progress/openttd-tunnel-portals.md`)、OpenTTDの「傾斜地から掘り始める」前提とは設計が違う。
  P7で傾斜レールを導入しても、トンネル側のロジックを OpenTTD 方式に寄せる必要は無い(現行の
  「山への埋没度で坑口を決める」方式のほうが16Kマップの決定的生成と相性がよい)。橋についても同様、
  現行の `rampHeightAtPos` ベースの連続坂表現を維持してよい。

---

## G. CubicTransimへの示唆(P7設計への橋渡し)

### 採用すべきもの
1. **タイル形状は4隅コーナー標高から `min/max` だけで導出する**
   (`GetTileSlopeGivenHeight` の式)。CubicTransimのコーナー格子は既にこの計算がそのまま可能な形。
   `cellHeightAt = min(4隅)` は既存のOpenTTD `GetTileZ` 相当、追加で `cellMaxHeightAt = max(4隅)` を
   用意すれば「そのセルは平坦か・どちらへ傾いているか」を即座に判定できる。
2. **Track方向とSlope方向の対応表**(D節)は、急斜面を除けば「1コーナー隆起→対角側の直線のみ無基礎」
   「隣接2コーナー隆起(傾斜地)→その斜め方向のみ無基礎」という2パターンに単純化できる。これを
   `sim/buildPreview.ts`(既存の建設可否判定の窓口)に問い合わせ関数として実装すればよい。
3. **駅は「基礎で水平化された同一高さ」を全セルに要求する**(E節)、車庫は「出口方向のコーナーが
   高すぎない」ことだけ要求する、という2段階のシンプルな規則をそのまま輸入できる。
4. **地形編集の段差1復元は、既存の `terrainEdit.ts` の方向つきBFS伝播が OpenTTD の
   `TerraformTileHeight` 再帰と同じ役割を果たしており、追加変更は不要**。ただし線路が絡む場合の
   扱い(現行: 一律no-op)を、傾斜レール対応後にどこまで許容するかは別途設計判断が要る(B-3節参照)。
5. **`train_slope_steepness` 既定値3%** は、勾配による速度影響を入れる場合の具体的な参考値として
   使える。

### 簡略化すべきもの(急斜面を当面スコープ外にする根拠)
- 急斜面(段差2, `SLOPE_STEEP_*`)とハーフタイル基礎(`SteepLower`/`SteepBoth`/`HalfTileW..N`)は、
  `Foundation` enum19種のうち10種類を占める最も複雑な部分。これを削ると:
  - `Foundation` は実質 `None / Leveled / InclinedX / InclinedY` の4種だけになる
  - `GetRailFoundation` の分岐は「急斜面ブランチ」を丸ごと削除でき、半分以下の複雑度になる
  - Slopeも19種→11種(FLAT + 4×1コーナー + 4×傾斜地 + 2×対角尾根谷)に減る
  - 既存の `TERRAIN_HEIGHT_MAX=10`・1-Lipschitz構成保証(隣接コーナー段差1以下)という現行の地形生成
    制約とも矛盾しない(=急斜面を禁止するだけで済み、生成アルゴリズムの変更が不要)
- ジグザグ防止の特殊基礎(`RailW/S/E/N`、`SpecialRailFoundation`)は、単一の直線Track+非対称な半端な
  斜面という狭いケース専用。CubicTransimが「傾斜地は斜めTrackのみ・それ以外はLeveled」という単純化を
  採るなら、このケース自体が発生しない(すべてLeveled行きになる)ため丸ごと不要。
- ハーフタイル駅(SLOPE_HALFTILE系)・急斜面の「片側だけ線路」表現は、描画・当たり判定のコストに
  見合わない装飾的挙動と判断し、当面見送ってよい。

### 開放しておく設計問題(P7で決めるべきこと)
1. **対角2コーナー隆起(尾根・谷、SLOPE_EW/NS相当)のセルに線路を敷けるか?** OpenTTDはLeveled基礎で
   敷設可能(平らな踏切のような扱い)。CubicTransimでも同様に許すか、それとも「尾根・谷セルは常に
   建設不可」という単純な制約にするかは要検討。後者のほうが実装・UIともに単純。
2. **駅の「複数セルにまたがる高さ統一」チェックをどこに置くか?** 既存の `buildPreview.ts` は
   construction.ts の apply系に判定を委譲する設計(CLAUDE.md 既定方針)なので、`applyStation` 系に
   「セルごとの実効水平高さが一致するか」の事前チェックを追加する形になる見込み。
3. **傾斜レールの建設コストに `Price::BuildFoundation` 相当の加算を設けるか?** 現行の橋(RAIL_COST×
   OVERPASS_COST_MULTIPLIER)やトンネル(×8倍)のような倍率方式と、OpenTTD流の「基礎が変わった分だけ
   定額加算」方式のどちらに寄せるかは経済バランス次第。
4. **急斜面(段差2)セルの扱い。** 生成そのものは1-Lipschitz制約で既に排除されている(段差1超は起きない
   設計)。P7でも「段差2セルは常に建設不可(平地化して回避)」というルールで足りるはずだが、地形編集
   (盛土/切土)で意図的に段差2を作れてしまわないかは `terrainEdit.ts` 側の再確認が必要。
5. **列車のZ位置・向き計算の窓口。** 現行 `trackPath.ts`/`rampHeightAtPos` は「セル内posに対する
   スムーズステップ補間」で完結しており、OpenTTDの `GetSlopePixelZ(x,y,ground_vehicle)` のような
   「タイル内座標→実高さ」の汎用関数は持っていない。傾斜地(1コーナー隆起や対角尾根谷)上を走る
   列車の高さ補間をどう表現するかは、既存の坂表現(2区間のsmoothstep)をそのまま流用できるか、
   コーナー単位の双線形補間(`GetPartialPixelZ` 相当)を新設するかの選択になる。
