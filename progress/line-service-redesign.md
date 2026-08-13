# 路線＋種別モデルへのグループ刷新

## Decision
- 旧「運用グループ」（列車起点で作る共有運行表）を廃し、**路線（LineData）を第一級の存在**にする。
  - `LineData` — id / name / colour / `stops: string[]`（物理経路＝全停車駅の並び）/ `mode`（loop/shuttle。線形は物理特性なので路線側に持つ）
  - `ServiceData`（種別） — id / lineId / name（各停・快速…）/ `skipStationIds: string[]` / `headwaySeconds`
  - 路線作成時に「各停」種別（skipなし）を自動生成。路線には常に1つ以上の種別が残る（最後の種別は削除不可）。
- 列車は `serviceId?` で（路線×種別）に所属。有効運行表 = `line.stops` から `skipStationIds` を除いた並び。未所属列車は従来どおり自前 `schedule`。
- **粒度の要**: 旅客グラフの partition key・発車間隔（headway）・到着案内は**種別単位**でキーする。路線単位にすると快速と各停が乗車判定で混同される（simulation.ts の `lineId = groupId ?? train.id` は実は「同一運行」の判定キー）。
- 通過駅の実現: 経路探索は元々点対点BFSで、目的駅以外の駅セルは素通りする。つまり skip-stop は**有効運行表から駅を除くだけ**で成立し、シムエンジンの改修は不要。
- `skipStationIds` を集合で持つ（stops と並んだ boolean 配列ではなく）理由: 路線に駅を挿入したとき、既存種別では新駅がデフォルト「停車」になり壊れない。
- セーブ v19。旧 `groups` は「路線＋各停種別」へ読込時に移行（group.id を line.id に流用、種別 id は `{groupId}:default`、`train.groupId` → 対応する default 種別の serviceId）。groupDepartures のキーも同様に読み替え。
- 削除時のフォールバック: 路線削除→所属列車は有効運行表を自前 schedule にコピーして単独運用へ。種別削除→列車は同路線の先頭種別へ付け替え。

## Alternatives considered
- 種別を「stops のサブセット配列」で持つ案 → 路線編集（駅挿入）でインデックスがずれるため却下。
- headway を路線単位にする案 → 種別ごとに運転頻度が違うのが普通（快速15分・各停5分）なので種別単位。種別間の続行間隔調整は現状もモデル外（既存の閉塞・予約に委ねる）。
- 旧セーブ切り捨て（v14→v15の前例）→ 移行が「グループ=路線+各停」の機械的対応で安価なので移行を書く。

## Constraints / Gotchas
- `copySchedule`/`pasteSchedule` は従来から自前 schedule のみを読み書きする（グループ在籍中は実態と乖離）。本刷新では単独運用列車専用の機能として UI 側で非所属時のみ表示し、仕様として明文化。
- `suggestsShuttle` は物理経路の話なので **line.stops** に対して評価する（種別のサブセットではない）。
- simulation.ts の serviceSignature キャッシュキーに種別 id と解決済み運行表を含めること（種別変更・路線編集で失効させる）。
- 種別で終端駅を通過にすることも許す（有効運行表が2駅未満になったら単に走らない）。
