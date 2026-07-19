# OpenTTDソース精読ノート（実装の教科書）

OpenTTD 実ソースコードの精読による挙動仕様の抽出。対象コミット: `OpenTTD/OpenTTD` master ブランチ（2026-07-20 取得）。取得したソースファイル（train_cmd.cpp / pbs.cpp / pbs.h / ground_vehicle.cpp / ground_vehicle.hpp / train.h）はセッションのスクラッチパッド `openttd/` ディレクトリに保存済み。

読者: CubicTransim（1セル=1タイル、編成=cars両、経路=セル列、`stepWorld(dt)`）の実装者。C++の逐語訳ではなく、再実装可能な粒度の挙動ルールとして記述する。

---

## A. 経路予約 (pbs.cpp / pbs.h)

### A-1. 挙動仕様

**予約の粒度**
- 予約は「タイル単位」ではなく「タイル + トラック(Track、対角線を含まない8方向のうち片側4方向のレール線分)」単位。`TrackBits`（ビットマスク）で保持。
- タイル種別ごとに予約の実体が異なる（`GetReservedTrackbits` が分岐）:
  - 通常線路（Plain Rail）: `GetRailReservationTrackBits` — トラックビットマスク
  - 車庫（Depot）: `GetDepotReservationTrackBits` — depot 1本のみなので実質 bool
  - 踏切（LevelCrossing）: `GetCrossingReservationTrackBits` — bool
  - 駅（Station, HasStationRail）: `GetStationReservationTrackBits` — プラットフォーム方向の1本のみ
  - トンネル/橋（TunnelBridge、Rail用途のみ）: `GetTunnelBridgeReservationTrackBits`

**TryReserveRailTrack(tile, track, trigger_stations=true) の役割**
- 指定タイル・トラックの予約取得を試みる `bool` 返却関数。
- 事前条件（assert）: そのタイルに実際に該当トラックの trackdir が存在すること。
- 処理:
  1. `_settings_client.gui.show_track_reservation` が真なら描画更新用に `MarkTileDirtyByTile`/`MarkBridgeDirty` を呼ぶ（見た目のみ、ロジックに影響なし）。
  2. タイル種別で分岐:
     - Plain Rail: `TryReserveTrack(tile, t)`（該当トラックが既に予約されていなければ成功、既存予約とクロスしなければ成功。トラック同士の交差判定はビット演算で「同一タイル内で交差する組」を定義したテーブルによる）
     - Depot: `!HasDepotReservation(tile)` なら予約フラグを立てて成功
     - LevelCrossing: `!HasCrossingReservation(tile)` なら予約フラグを立て `UpdateLevelCrossing(tile, false)` を呼んで成功（踏切遮断機の見た目更新）
     - Station: `HasStationRail(tile) && !HasStationReservation(tile)` なら予約フラグを立て、`trigger_stations=true` の場合は駅のランダム化/アニメーショントリガ（`StationRandomTrigger::PathReservation`）を発火させて成功
     - TunnelBridge: `GetTunnelBridgeReservationTrackBits(tile).None()`（まだ誰も予約していない）なら予約を立てて成功。**橋・トンネルは片側のタイルのみに予約フラグを持ち、対岸は別途 `GetOtherTunnelBridgeEnd` で扱う**。
  3. 上記以外（既に予約済み等）は `false`。

**UnreserveRailTrack(tile, track) の役割**
- 上記の逆。タイル種別ごとに対応する Setter を `false` にするだけ。Depot/LevelCrossing/Station はそれぞれ描画更新も行う。

**FollowTrainReservation(consist, train_on_res=nullptr) の役割**
- 列車の現在位置から先の予約済み経路を終端までトレースし `PBSTileInfo{tile, trackdir, okay}` を返す。
- 内部で `FollowReservation(owner, railtypes, tile, trackdir)` を呼ぶ静的ヘルパーが本体：
  - `CFollowTrackRail`（既存のタイル追跡ユーティリティ）で1タイルずつ進み、次タイルの予約済み trackdir ビットと交差する箇所を追う。
  - 予約が途切れたら終了（`reserved.None()`）。ただし駅タイルでは、追跡がスキップしたプラットフォームタイル内に予約が終わっている可能性があるため、スキップ分を逆に遡ってチェックする（`ft.tiles_skipped`）。
  - 一方向PBS信号（one-way signal）が逆向きにブロックしていれば、その予約は自分のものではあり得ないとして打ち切り。
  - Depot タイルに達したら打ち切り。
  - 通常信号（block signal、非PBS）のある trackdir に達したら打ち切り（PBSはそこまで）。
  - ループ検出（同一 tile+trackdir に戻ったら打ち切り）。
- `train_on_res` が指定されると、終端タイル上（駅なら全プラットフォーム、トンネル/橋なら対岸も含む）に存在する他列車を `CheckTrainsOnTrack` で検索し、**同一タイルにいる列車のうち最小 VehicleID のもの**を返す（デシンク回避のため決定的に選ぶ）。

**GetTrainForReservation(tile, track)**
- 特定タイル・トラックの予約が「どの列車のものか」を、両方向（前後）に `FollowReservation` を辿って終端の列車を探すことで特定する。一方向信号があれば探索方向を打ち切る。

**IsSafeWaitingPosition(v, tile, trackdir, include_line_end, forbid_90deg) — 「安全な待機位置」の判定**

判定は次の優先順位（早期 return）:
1. **Depot タイルなら常に安全** (`IsRailDepotTile(tile)` → true)
2. **現在の trackdir に通常信号(非PBS、block signal)があれば安全** (`HasBlockSignalOnTrackdir`)。従来型信号の手前で待つのは常に安全という設計。
3. 次タイルへ `CFollowTrackRail` で進めるかチェック:
   - **進めない（行き止まり）場合**: `include_line_end` が true のときのみ安全（終端駅の最終タイル等）
   - 90度ターン禁止設定が有効かつ90度ターンになる場合、その trackdir を候補から除外
   - 候補 trackdir が0本になったら `include_line_end` の値を返す
   - **候補 trackdir が1本のみ**の場合:
     - その先にPBS信号があれば安全 (`HasPbsSignalOnTrackdir`)
     - その先の逆向きに `SignalType::PathOneWay`（一方向PBS信号）があれば、`include_line_end` の値を返す（＝終端許容時のみ安全＝行き止まりに準ずる特殊ケース）
   - **候補 trackdir が2本以上（分岐点）は常に不安全**（false）— 分岐点で待たれると経路選択の自由度がなくなるため。

**IsWaitingPositionFree(v, tile, trackdir, forbid_90deg)**
- 「安全な待機位置」として選んだ場所が**現在空いているか**（予約されていないか）を確認する別関数:
  1. まず現在タイルの該当トラックが既に予約されていれば即 false。
  2. Depot タイル or 通常信号の trackdir なら即 true。
  3. 次タイルへ進めなければ true（行き止まりは自動的に空き扱い）。
  4. 90度ターン制限を適用した上で、次タイルの到達可能 trackdir のいずれかに予約があれば false、なければ true。
  5. ここでは railtype 互換性チェックを**意図的に行わない**（コメント: 「異なる鉄道種別の予約同士を誤って接続しないように」全 railtype 対象で確認）。

**予約解放のタイミング（train_cmd.cpp 内）**

`ClearPathReservation(const Train *v, TileIndex tile, Trackdir track_dir)`（単一タイル解放）:

```cpp
static void ClearPathReservation(const Train *v, TileIndex tile, Trackdir track_dir)
{
    DiagDirection dir = TrackdirToExitdir(track_dir);
    if (IsTileType(tile, TileType::TunnelBridge)) {
        if (GetTunnelBridgeDirection(tile) == ReverseDiagDir(dir)) {
            TileIndex end = GetOtherTunnelBridgeEnd(tile);
            if (TunnelBridgeIsFree(tile, end, v).Succeeded()) {
                SetTunnelBridgeReservation(tile, false);
                SetTunnelBridgeReservation(end, false);
                // 描画更新のみ
            }
        }
    } else if (IsRailStationTile(tile)) {
        TileIndex new_tile = TileAddByDiagDir(tile, dir);
        if (!IsCompatibleTrainStationTile(new_tile, tile)) {
            SetRailStationPlatformReservation(tile, ReverseDiagDir(dir), false);
        }
    } else {
        UnreserveRailTrack(tile, TrackdirToTrack(track_dir));
    }
}
```

- **トンネル/橋**は「出口側から出る」時のみ解放を試み、かつ**対岸まで含めて他列車がいなければ**両端を解放する（`TunnelBridgeIsFree`）。列車がまだトンネル内にいる間は解放されない。
- **駅**は「次タイルが同じプラットフォームの続きでない」時にのみ「プラットフォーム全体」の予約を解放する（`SetRailStationPlatformReservation` は開始タイルから同方向にプラットフォーム終端まで一括セット）。つまり、駅の途中タイルを1つ通過しただけでは解放されず、プラットフォームを完全に離れた時に一括解放される。
- 呼び出し元: `FreeTrainTrackReservation`（後述）と `Train::Crash()`（衝突時、全連結車両の現在 tile について呼ぶ）。

`FreeTrainTrackReservation(const Train *consist)`（前方全体の解放）:
- 列車先頭から `CFollowTrackRail` で前方へタイルを辿りながら、各タイルで `ClearPathReservation` を呼ぶループ。
- ループ終了条件:
  - 通常信号（非PBS）の trackdir に達したら、そのトラックだけ `UnreserveRailTrack` して打ち切り
  - PBS信号の trackdir に達したら:
    - 既に赤ならそこまで（自分の予約ではないはず）で打ち切り
    - 緑なら赤に戻して継続（自分の予約分の信号だったということ）
  - 逆向きにPBS信号があれば `AddSideToSignalBuffer` で信号再評価をマーク
  - 逆向きに一方向通常信号があれば打ち切り
- 「最初のタイル（現在乗っている駅/橋/トンネルタイル）」は、まだそこに列車の一部が乗っている場合は解放しない（`free_tile` フラグで制御、2周目以降は必ず解放）。
- ループ後 `UpdateSignalsInBuffer()` で信号再評価をまとめて実行。
- **呼び出しタイミング**: `ReverseTrainDirection`（反転前・条件付き）、`Train::Crash()`（衝突時、非スタック状態のみ）、`ChooseTrainTrack`（予約失敗時の巻き戻し用）。

**列車後端がタイルを通過した際の扱い**: 後端通過時の解放は「前方全体を再帰的に辿って現在の実際の予約状態から復元する」設計であり、後端が通過するたびに個別のタイルを都度アンリザーブするわけではない（`FreeTrainTrackReservation` は「前方の予約全部を破棄する」操作であって、通常の走行中は `ExtendTrainReservation` 側で新規予約を積むのみ）。実際には、通常走行時に後端が抜けたタイルの解放は明示的に見当たらず、**PBS予約は「列車の現在位置より前方の未通過分」を指すため、後端が通過したタイル自体はそもそも「現在位置の後方」＝予約対象外になる**という設計（＝列車位置更新のたびに前方予約を再計算するのではなく、必要な時（反転・スタック・衝突・区間再取得）にのみ明示的に解放・再取得する）。

### A-2. 参照ファイル/関数
- `pbs.cpp`: `TryReserveRailTrack`, `UnreserveRailTrack`, `FollowReservation`(static), `FollowTrainReservation`, `CheckTrainsOnTrack`(static), `GetTrainForReservation`, `IsSafeWaitingPosition`, `IsWaitingPositionFree`, `SetRailStationPlatformReservation`, `GetReservedTrackbits`
- `pbs.h`: `struct PBSTileInfo{tile, trackdir, okay}`, `HasReservedTracks`(inline)
- `train_cmd.cpp`: `TryPathReserve`, `ChooseTrainTrack`, `ExtendTrainReservation`, `FreeTrainTrackReservation`, `ClearPathReservation`, `TryReserveSafeTrack`

### A-3. 簡易ゲームへの適用メモ
- 1セル粒度実装では「タイル+トラック方向」の代わりに「セル+進行方向（あるいは単純に『セルが予約中か』の boolean）」で十分近似可能。カーブや複線がなければトラックビットの分岐は不要。
- 「安全な待機位置」の判定は簡略化して: 「次のセルが行き止まり／駅終端／車庫／信号のある分岐直前」なら安全、「次が分岐で信号がない」なら不安全、とするだけでも十分にPBSらしい振る舞いになる。
- 駅プラットフォーム予約の「プラットフォーム全体を一括予約/解放」という考え方は、既存のCubicTransimの停車位置延長ロジック（ホーム奥端まで経路延長、直近のコミット参照）と相性が良い。列車がホームの一部にでもいる間は、ホーム全域を1つの予約単位として扱うと実装が楽。
- トンネル/橋の「対岸を見て空いていれば両端解放」は単線トンネルがあるゲームでのみ必要。CubicTransimに単線橋トンネル要素がなければ省略可。

---

## B. 停車処理 (train_cmd.cpp)

### B-1. 挙動仕様

**GetTrainStopLocation(station_id, tile, moving_front, *station_ahead, *station_length)** — 停車位置計算の中核

```cpp
int GetTrainStopLocation(StationID station_id, TileIndex tile, const Train *moving_front, int *station_ahead, int *station_length)
{
    const Train *consist = moving_front->First();
    const Station *st = Station::Get(station_id);
    *station_ahead  = st->GetPlatformLength(tile, DirToDiagDir(moving_front->GetMovingDirection())) * TILE_SIZE;
    *station_length = st->GetPlatformLength(tile) * TILE_SIZE;

    OrderStopLocation osl = OrderStopLocation::Middle;
    if (consist->gcache.cached_total_length >= *station_length) {
        osl = OrderStopLocation::FarEnd;              // 編成がホームより長い→奥端で止める
    } else if (consist->current_order.IsType(OT_GOTO_STATION) && consist->current_order.GetDestination() == station_id) {
        osl = consist->current_order.GetStopLocation(); // オーダーで指定されたNear/Middle/Far
    }

    int stop;
    switch (osl) {
        case OrderStopLocation::NearEnd:  stop = consist->gcache.cached_total_length; break;
        case OrderStopLocation::Middle:   stop = *station_length - (*station_length - consist->gcache.cached_total_length) / 2; break;
        case OrderStopLocation::FarEnd:   stop = *station_length; break;
    }

    uint8_t rounding = consist->IsDrivingBackwards() ? 2 : 1;
    return stop - (consist->gcache.cached_veh_length + rounding) / 2;
}
```

- 単位は「1/16タイル」（`TILE_SIZE` は 16）。`station_ahead`/`station_length` はプラットフォーム長を16倍したもの。
- **ホーム長より編成が長い場合は無条件で FarEnd（奥端）に固定**（オーダー指定を無視）。← CubicTransim 直近コミットの「停車位置をホーム全体基準に変更」の実装と符合する挙動仕様。
- 停車位置は「列車先頭の中心」を基準に計算し、最後に**先頭車両の半分の長さ**（前進なら `(veh_length+1)/2`、後進なら `(veh_length+2)/2`）を引いて実際の停止基準点に補正する。

**減速目標の与え方（Realistic モデルのみ有効。Original モデルではこの減速ロジックは適用されない）**

`Train::GetCurrentMaxSpeed()` 内:

```cpp
if (RealisticModel && IsRailStationTile(moving_front->tile)) {
    StationID sid = GetStationIndex(moving_front->tile);
    if (this->current_order.ShouldStopAtStation(this, sid)) {
        int stop_at = GetTrainStopLocation(sid, moving_front->tile, moving_front, &station_ahead, &station_length);
        int distance_to_go = station_ahead / TILE_SIZE - (station_length - stop_at) / TILE_SIZE; // 残りセル数相当
        if (distance_to_go > 0) {
            int st_max_speed = 120;
            int delta_v = this->cur_speed / (distance_to_go + 1);
            if (max_speed > (this->cur_speed - delta_v)) st_max_speed = this->cur_speed - (delta_v / 10);
            st_max_speed = std::max(st_max_speed, 25 * distance_to_go);
            max_speed = std::min(max_speed, st_max_speed);
        }
    }
}
```

- 停止目標までの残り距離（タイル数換算）に応じて**許容最高速度そのものを毎tick再計算して絞り込む**方式。厳密な物理ブレーキ距離計算ではなく、「残り距離が短いほど許容速度を下げる」**ヒューリスティック**。
  - `st_max_speed` の下限は `25 * distance_to_go`（km/h、残り1タイルなら25km/h以上は許容しない）
  - 現在速度からの減速幅は `delta_v/10`（現在速度と残り距離の比に応じた微減）
- 停車判定・実際の到着処理そのものは別関数（`TrainController`→`TrainCheckIfLineEnds`→駅到着検知、後述）が担う。

**駅到着から発車までの一連の流れ（`TrainLocoHandler`, `TrainCheckIfLineEnds` 経由）**
- `TrainCheckIfLineEnds(moving_front, reverse)`:
  - 故障中(`breakdown_ctr>1`)なら `VehState::TrainSlowing` をセットし、故障速度テーブル `_breakdown_speeds[]` で速度を制限。
  - `TrainCanLeaveTile` が false なら return true（まだこのタイルに留まる＝実質「動けない」ケース）。
  - 次タイルの track status を取得し、進入可能 trackdir が無い/赤信号なら `TrainApproachingLineEnd` を呼ぶ（停止トリガ、後で反転や停止処理につながる）。
  - 踏切に近づいていれば `MaybeBarCrossingWithSound` で遮断機を閉じる。
- `TrainEnterStation(consist, station)`:

```cpp
static void TrainEnterStation(Train *consist, StationID station)
{
    consist->last_station_visited = station;
    // 初訪問ならニュース・AIイベント発行
    consist->force_proceed = TFP_NONE;
    consist->BeginLoading();          // ← 実質の「停止・積み下ろし開始」処理はBeginLoading()に委譲
    // 駅のランダム化/アニメーショントリガ(VehicleArrives)
}
```

  - **実際の「その位置で完全停止させる」処理自体は本関数にはなく、`Vehicle::BeginLoading()`（vehicle.cpp 側、共通ロジック）に委ねられている**（今回精読対象外ファイル。停止位置に到達したことをトリガーに呼ばれる想定）。

**発車時処理（`TrainLocoHandler` 内、`VehicleRailFlag::LeavingStation` 処理）**

```cpp
} else if (consist->flags.Test(VehicleRailFlag::LeavingStation)) {
    const Train *moving_front = consist->GetMovingFront();
    DiagDirection dir = VehicleExitDir(moving_front->GetMovingDirection(), moving_front->track);
    if (IsRailDepotTile(moving_front->tile) || IsTileType(moving_front->tile, TileType::TunnelBridge)) dir = DiagDirection::Invalid;
    if (UpdateSignalsOnSegment(moving_front->tile, dir, consist->owner) == SigSegState::Path || _settings_game.pf.reserve_paths) {
        TryPathReserve(consist, true, true);
    }
    consist->flags.Reset(VehicleRailFlag::LeavingStation);
}
```

- 発車時に「PBS区間にいる、またはグローバル設定で常時経路予約する」場合のみ `TryPathReserve` を再実行し、経路を再確保する（オーバーレングス編成が駅で向きを変えて出た場合など、予約フラグが立っていないケースの救済コメントあり）。

**ReverseTrainDirection 呼び出し条件（発車関連）**
- `TrainLocoHandler` 冒頭: `consist->flags.Test(VehicleRailFlag::Reversing) && consist->cur_speed == 0` → 完全停止した時点で `ReverseTrainDirection` 実行（＝Realistic モデルで速度>0のまま反転命令が来た場合は速度0になるまで遅延される。Original モデルは即座に速度0にしてから即反転、`CmdReverseTrainDirection` 参照）。
- `ProcessOrders(consist) && CheckReverseTrain(consist)` → オーダー処理の結果、経路探索(`YapfTrainCheckReverse`)が「引き返した方が早い」と判断した場合に即座に反転（速度即0リセットしてから）。

### B-2. 参照ファイル/関数
- `GetTrainStopLocation`, `Train::GetCurrentMaxSpeed`, `TrainEnterStation`, `TrainCheckIfLineEnds`, `TrainLocoHandler`, `TrainCanLeaveTile`, `Train::UpdateSpeed`（すべて train_cmd.cpp）
- `OrderStopLocation` 列挙（NearEnd/Middle/FarEnd）は `order_type.h` 側（未読だが呼び出しから型が明白）

### B-3. 簡易ゲームへの適用メモ
- 「編成長 ≥ ホーム長なら FarEnd 固定」というルールは、CubicTransim の直近実装（ホーム全体基準の停車位置延長）と方向性が一致する。追加で「Near/Middle/Far」の3種を停車オーダーオプションとして持たせるなら、この式（`stop_at = 目標位置 - 先頭車両半分`）をそのままセル単位に翻訳可能：
  - `stopCell = targetEndCell(NearEnd|Middle|FarEnd) - ceil(headCarLength/2)`
- 減速ヒューリスティック（`st_max_speed = max(25*残りセル数, cur_speed - delta_v/10)`）は実装コストが低く、物理ベースのブレーキ距離計算より簡単。CubicTransim が dt 秒刻みの stepWorld なら、「残りセル数」から毎 tick 許容速度を絞り込む形にそのまま移植できる。
- 停止確定・積み下ろし開始のトリガー自体（`BeginLoading` 相当）は OpenTTD 本体でも別ファイルに分離されており、今回の調査範囲では発見できなかった。CubicTransim 側は既存の到着イベント処理をそのまま使ってよい。

---

## C. 速度・加減速 (ground_vehicle.cpp / train_cmd.cpp)

### C-1. 挙動仕様

**2つの加速度モデルの切り替え（`Train::UpdateSpeed()`）**

```cpp
int Train::UpdateSpeed()
{
    switch (_settings_game.vehicle.train_acceleration_model) {
        case AccelerationModel::Original:
            return this->DoUpdateSpeed(this->acceleration * (Brake ? -4 : 2), 0, this->GetCurrentMaxSpeed());
        case AccelerationModel::Realistic:
            return this->DoUpdateSpeed(this->GetAcceleration(), Brake ? 0 : 2, this->GetCurrentMaxSpeed());
    }
}
```

**Original モデル（単純モデル）**
- `Train::UpdateAcceleration()`（ConsistChanged/CargoChanged 後に呼ばれる、キャッシュ更新）:

  ```cpp
  this->acceleration = Clamp(power / weight * 4, 1, 255);
  ```

  つまり「1馬力あたり重量比×4」を1〜255にクランプした固定値を、加速時は `×2`、ブレーキ時は `×(-4)` して `DoUpdateSpeed` に渡す。**物理力学的な抵抗計算は一切なし**、パワー/重量比だけで決まる非常に単純なモデル。
- 坂・カーブによる速度変化は別途 `AffectSpeedByZChange`（Z座標変化時）で処理：`_accel_slowdown[]` テーブル（通常鉄道/モノレール/マグレブごとに `small_turn`, `large_turn`, `z_up`, `z_down` の4係数、値は `{256/4, 256/2, 256/4, 2}` など）を使い、上り坂では `cur_speed -= cur_speed*z_up>>8`、下り坂では `cur_speed += z_down`（上限 max_track_speed まで）。

**Realistic モデル（物理モデル、`GroundVehicle::GetAcceleration()`、ground_vehicle.cpp）**

主要な力の計算式（コメントより忠実に抽出）:

```cpp
int64_t speed = 現在速度 [km/h相当];
int64_t mass  = gcache.cached_weight [トン];
int64_t power = gcache.cached_power * 746;  // HP→W (1HP=746W)

int64_t resistance = 0;
if (!maglev) {
    resistance  = gcache.cached_axle_resistance;      // = 10 * 総重量  (軸受摩擦, N)
    resistance += mass * v->GetRollingFriction();      // 転がり摩擦, N
}
resistance += area * gcache.cached_air_drag * speed * speed / 1000;  // 空気抵抗
resistance += GetSlopeResistance();                    // 勾配抵抗（登り+, 下り-）

int64_t force;
if (speed > 0) {
    if (!maglev) {
        force = power * 18 / (speed * 5);   // km/h→m/s変換(5/18)の逆数、F=P/v
        if (加速モード && force > max_te) force = max_te;   // 粘着限界(牽引力上限)でクランプ
    } else {
        force = power / 25;
    }
} else {
    // 発進時の「キックオフ」牽引力
    force = (加速モード && !maglev) ? min(max_te, power) : power;
    force = max(force, mass*8 + resistance);
}

if (加速モード) {
    if (force == resistance) return 0;
    accel = Clamp((force - resistance) / (mass * 4), int32_t範囲);
    return force < resistance ? min(-1, accel) : max(1, accel);
} else { // ブレーキモード
    return Clamp(min(-force - resistance, -10000) / mass, int32_t範囲);
}
```

**各抵抗要素の定数・式**:

| 要素 | 式 | 備考 |
|---|---|---|
| 軸受摩擦 (`cached_axle_resistance`) | `10 × 総重量` | `CargoChanged()` で算出、「重量の0.1%相当」 |
| 転がり摩擦係数 (`GetRollingFriction`) | `15 × (512 + 現在速度) / 512` [×1e-4] | 鋼対鋼で0.1〜0.2%、速度が上がると増加（512km/hで2倍、1024km/hで3倍） |
| 勾配抵抗 (`cached_slope_resistance`) | `重量 × slope_steepness × 100` | `slope_steepness` は `_settings_game.vehicle.train_slope_steepness`（設定値。既定値はソースから直接確認できず、一般に3〔%〕程度とされる【推測】） |
| 空気抵抗 (`cached_air_drag`) | Air drag 値0（既定）の場合 `max_speed<=10 ? 192 : max(2048/max_speed, 1)`、値が明示されている場合は `(value==1) ? 0 : value`。さらに `cached_air_drag = air_drag + 3*air_drag*連結数/20` | 連結数が多いほど抵抗増加 |
| 空気抵抗の最終項 | `area × cached_air_drag × speed² / 1000` | `area = GetAirDragArea()` |
| 牽引力上限（粘着限界, max_te） | `Σ(u->GetWeight() × u->GetTractiveEffort()) × GROUND_ACCELERATION / 256` | `GROUND_ACCELERATION = 9800`（重力加速度9.8m/s²を1000倍した固定値、`vehicle_type.h` で定義）。`GetTractiveEffort()` は0-255の粘着係数 |
| 発進時最低ケツ推し | `max(force, mass*8 + resistance)` | 発進不能を防ぐための下駄 |
| ブレーキ力下限 | `min(-force - resistance, -10000)` | 最低でも一定のブレーキ力を保証、ゆっくり坂を下る場合でも確実に減速させる |
| 加速度分母 | `mass × 4` | 単位変換用の固定係数 |

**速度積分・更新（`GroundVehicle::DoUpdateSpeed(accel, min_speed, max_speed)`、ground_vehicle.hpp）**

```cpp
inline uint DoUpdateSpeed(uint accel, int min_speed, int max_speed)
{
    uint spd = this->subspeed + accel;
    this->subspeed = (uint8_t)spd;                      // 端数(サブスピード)を8bit精度で保持

    int tempmax = max_speed;
    if (this->cur_speed > max_speed) {
        // 最高速度超過時は緩やかに減速（10分の1ずつ）、ただしmax_speedを下回らない
        tempmax = std::max(this->cur_speed - (this->cur_speed / 10) - 1, max_speed);
    }

    this->cur_speed = spd = std::max(std::min(this->cur_speed + ((int)spd >> 8), tempmax), min_speed);

    int scaled_spd = this->GetAdvanceSpeed(spd);
    scaled_spd += this->progress;
    this->progress = 0;
    return scaled_spd;
}
```

- 速度はサブスピード（8bit小数部）を持つ固定小数点演算。`accel` は「1tickあたりの speed×256 単位の増分」。
- **最高速度超過からの減速は瞬時にクランプせず「現在速度の1/10ずつ緩やかに」減らす**という特徴的な挙動（例: カーブ制限や停車速度制限に引っかかった直後の急減速を緩和するための仕様）。
- `min_speed` は加速モードで0、ブレーキモードでも0（Original モデル）または Realistic モデルでも共通して0を渡している（train_cmd.cpp の UpdateSpeed 呼び出しを見るとどちらも `Brake?0:2`）。

**停止判定**: 明示的な「これ以下ならゼロにする」処理は今回読んだ範囲では確認できず。`min_speed=0` によって `std::max(…, min_speed)` が働き自然に0でクランプされる形。停止判定自体（`cur_speed == 0` チェック）は `TrainLocoHandler` 側で行われている（`consist->cur_speed == 0` を随所でチェック）。

### C-2. 参照ファイル/関数
- `GroundVehicle<T,Type>::GetAcceleration()`, `PowerChanged()`, `CargoChanged()`（ground_vehicle.cpp）
- `GroundVehicle::DoUpdateSpeed()`, `GetSlopeResistance()`, `GroundVehicleCache` 構造体（ground_vehicle.hpp）
- `Train::UpdateSpeed()`, `Train::UpdateAcceleration()`, `AffectSpeedByZChange()`, `_accel_slowdown[]`（train_cmd.cpp）
- `Train::GetRollingFriction()`, `Train::GetSlopeSteepness()`（train.h）
- `GROUND_ACCELERATION = 9800`（vehicle_type.h）

### C-3. 簡易ゲームへの適用メモ
- CubicTransim が「単一編成の質量・出力」を持つシンプルなモデルなら、**Original モデル**（`power/weight比を固定加速度化`）の方が実装・デバッグが圧倒的に楽で、TypeScript の stepWorld(dt) にもそのまま馴染む。Realistic モデルは空気抵抗・勾配・粘着限界など多数のパラメータが要るため、坂道やカーブ演出を作り込みたい場合のみ採用を検討。
- 移植時の最小構成案（Original 準拠）:

  ```
  acceleration = clamp(power / weight * 4, 1, 255)   // 定数キャッシュ
  accelStep = acceleration * (braking ? -4 : 2)       // dtに応じてスケール
  subspeed = (subspeed + accelStep) 的な固定小数点、または単純にdt×accelStep [km/h/s]を直接cur_speedに加算する簡略化でも良い
  cur_speed = clamp(cur_speed + accelStep, 0, maxSpeed)
  ```

- 「最高速度超過時は1/10ずつ緩やかに減速」という仕様は、カーブ制限や駅停止減速で速度上限が急に下がった際の見た目の滑らかさに寄与する。CubicTransim で急な速度上限低下（カーブ進入、停止目標接近）がある場合はこの緩和ロジックを踏襲すると自然な挙動になる。
- 空気抵抗・勾配抵抗はグリッドベースの平坦マップなら省略可能。将来的に高低差要素を入れるなら「登り区間は減速、下り区間は緩加速」という程度の簡易版で十分。

---

## D. 折り返し (ReverseTrainDirection)

### D-1. 挙動仕様

```cpp
static void ReverseTrainDirection(Train *consist)
{
    Train *moving_front = consist->GetMovingFront();
    if (IsRailDepotTile(moving_front->tile)) {
        if (IsWholeTrainInsideDepot(consist)) return;   // 車庫内に完全に収まっている場合は反転処理をしない
        InvalidateWindowData(...);
    }

    // 1. スタックしていなければ前方予約を解放
    if (!consist->flags.Test(VehicleRailFlag::Stuck)) FreeTrainTrackReservation(consist);

    TileIndex crossing = TrainApproachingCrossingTile(moving_front); // 踏切接近状態を保存

    // 2. バックアップ方式か、フリップ方式かを選択
    if (consist->vehicle_flags.Test(VehicleFlag::DrivingBackwards)
        || 設定でフリップ反転が禁止
        || consist->Last()->CanLeadTrain()) {
        // --- バックアップ反転：後退フラグを反転するだけ、車両順序・向きは変えない ---
        consist->vehicle_flags.Flip(VehicleFlag::DrivingBackwards);
        for (各車両 u) {
            登坂/降坂フラグを反転;
            UpdateStatusAfterSwap(u, false);
        }
    } else {
        // --- フリップ反転：車両順序・向きを完全に入れ替える ---
        AdvanceWagonsBeforeSwap(moving_front);
        ReverseTrainSwapVehicles(consist);   // start<->end, start+1<->end-1 の順で交換
        AdvanceWagonsAfterSwap(moving_front);
    }

    consist->flags.Flip(VehicleRailFlag::Reversed);
    consist->flags.Reset(VehicleRailFlag::Reversing);
    consist->ConsistChanged(CCF_TRACK);       // キャッシュ再計算（重量・出力・長さ等）
    // 表示更新、踏切状態更新...

    if (moving_front->track == Track::Depot) {
        consist->flags.Reset(VehicleRailFlag::Stuck);  // 車庫内は常に安全なのでスタック解除して終了
        return;
    }

    // 3. 条件付きで新規予約を再取得
    if (UpdateSignalsOnSegment(...) == SigSegState::Path || _settings_game.pf.reserve_paths) {
        bool first_tile_okay = !HasBlockSignalOnTrackdir(現在tile, 現在trackdir);
        if (IsRailDepotTile(...) && 車庫の出口方向を向いている) first_tile_okay = false;
        if (IsRailStationTile(現在tile)) SetRailStationPlatformReservation(..., true);
        if (TryPathReserve(consist, false, first_tile_okay)) {
            CheckNextTrainTile(consist);
        } else if (積み下ろし中でなければ) {
            MarkTrainAsStuck(consist);
        }
    } else if (consist->flags.Test(VehicleRailFlag::Stuck)) {
        consist->flags.Reset(VehicleRailFlag::Stuck);   // PBS区間外ならスタック扱い解除
    }
}
```

**反転時に何が入れ替わるか**

| 方式 | 発生条件 | 車両順序 | 向き(direction) | 座標(x/y/z) | DrivingBackwards フラグ |
|---|---|---|---|---|---|
| バックアップ | 既に後退中／設定でフリップ禁止／最後尾が CanLeadTrain（先頭になれる車両＝機関車や運転台付き） | 変わらない | 変わらない | 変わらない | 反転（トグル） |
| フリップ | 上記以外（通常ケース） | 完全に前後入れ替え（`start<->end`, `start+1<->end-1`, …） | 各車両とも反転 | 交換される | 変わらない |

- **予約の扱い**: フリップ／バックアップいずれの方式でも、反転処理そのものの中では**新規予約は作られない**。手順は必ず「①（非スタック時のみ）前方予約を全解放 → ②車両の物理的な入れ替え → ③（PBS区間内、または `reserve_paths` 設定が有効な場合のみ）新規に `TryPathReserve` で経路取得を試行」という順序。
- 予約再取得に失敗した場合は `MarkTrainAsStuck` でスタック状態にする（ただし積み下ろし中の場合は待つ）。
- 車庫内で完全収容されている場合（`IsWholeTrainInsideDepot`）は反転処理そのものを行わず return する＝車庫内での方向転換は実質何もしない。
- `CmdReverseTrainDirection`（プレイヤーコマンド側）を見ると、Realistic モデルかつ速度>0の場合は即座に反転させず `VehicleRailFlag::Reversing` フラグを立てるだけにして、`TrainLocoHandler` 側で**速度が0になった時点で初めて実際の `ReverseTrainDirection` を呼ぶ**（急停止からの瞬間反転を避ける仕様）。Original モデル、または Realistic でも既に速度0の場合は即座に `cur_speed=0` にセットしてから `ReverseTrainDirection` を呼ぶ。

### D-2. 参照ファイル/関数
- `ReverseTrainDirection`, `CmdReverseTrainDirection`, `TrainLocoHandler`（train_cmd.cpp）
- （呼び出しのみ確認、定義は範囲外）`AdvanceWagonsBeforeSwap`, `ReverseTrainSwapVehicles`, `AdvanceWagonsAfterSwap`, `UpdateStatusAfterSwap`, `IsWholeTrainInsideDepot`, `TrainApproachingCrossingTile`

### D-3. 簡易ゲームへの適用メモ
- CubicTransim のように「編成=cars両、経路=セル列」でシンプルに管理している場合、**バックアップ方式（車両順序を変えず進行方向フラグだけ反転）が実装コストが低く、かつ OpenTTD の標準挙動（双方向運転台がある場合の一般的な挙動）に近い**。フリップ方式（連結順序を丸ごと逆転）はビジュアル上「機関車が必ず先頭になる」独特の挙動なので、再現するかどうかは仕様判断次第。
- 重要な学び: 「反転コマンドを受けても速度が0になるまで実際の反転処理を遅延する」設計は、直近のコミットで修正された「停車直後の駅への即到着分岐が再発火し発車不能になる回帰」のようなタイミングバグを避ける上で参考になる。反転は「フラグを立てる」→「速度0を確認してから実処理」という2段階に分離するのが OpenTTD 流であり、CubicTransim でも同様の2段階処理を検討する価値がある。
- 予約解放→車両入替→予約再取得、という順序性（特に「非スタック時のみ解放」「車庫内なら予約処理をスキップ」）は、CubicTransim の PBS 的な経路管理を実装する際にそのまま踏襲可能な設計指針。

---

## 読めなかった/確認できなかった項目

- `TrainEnterStation` が実際に列車を停止させる処理そのもの（`Vehicle::BeginLoading()` の中身）は `train_cmd.cpp` にはなく、別ファイル（vehicle.cpp 推定）にあるため未確認。
- `DoUpdateSpeed` の「停止判定」を明示的に行うコードは見当たらず、`min_speed=0` によるクランプで暗黙的に実現されていると【推測】。専用の停止判定関数は存在しない。
- `_settings_game.vehicle.train_slope_steepness` の既定値は特定できず。一般に3(%)程度とされるが【推測】に留まる。
- `ChooseTrainTrack` と `YapfTrainChooseTrack`（実際のパスファインダー本体、YAPF）の内部アルゴリズムは `train_cmd.cpp` の範囲外（`yapf/` ディレクトリ）にあるため未調査。
