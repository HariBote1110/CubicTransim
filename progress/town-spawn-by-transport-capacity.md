# 町の湧きを「駅の即時湧き」から「輸送力ベースの日次判定」に変更

## Decision

- v0.3.0-Alpha-18: 「適当に駅を置いたら町が湧く」違和感を解消するため、駅設置時の
  即時湧き(旧`maybeSpawnTownForStation`/`resolveTownSpawnForStation`、駅を置いた瞬間に
  近くに町が無ければ`NEW_TOWN_CHANCE`(=0.5)の確率で即座に新しい町を生成)を廃止した。
- 代わりに、`sim/towns.ts`の`resolveTownSpawnTick(stationInfos, towns, terrain, rng)`を
  `stepWorld`(sim/simulation.ts)の**日次ティック**(`dayIndexOf`が変わったtick、
  `SECONDS_PER_DAY`=10秒ぶんに1回)から呼ぶ。各駅について
  1. `StationTransportInfo.capacity`(その駅に停車する運行を持つ列車の編成定員合計、
     `simulation.ts`の`computeStationTransportInfos`が`effectiveSchedule`+`cars×CAPACITY_PER_CAR`
     で集計してから`towns.ts`に渡す。towns.tsはtrains/groupsの型を知らないままにしたいので、
     集計はsimulation.ts側の責務にした)が`TOWN_SPAWN_CAPACITY_THRESHOLD`(=100、定員2両ぶん)
     以上
  2. `nearestTownWithinRadius`(既存の`TOWN_STATION_RADIUS`=10を流用)で近くに町が無い
  の両方を満たせば、`townSpawnChance(capacity)`(輸送力に比例する単純な線形、
  `TOWN_SPAWN_BASE_CHANCE`=0.05を閾値ちょうどのときの確率とし、輸送力が増えるほど
  上がって1で頭打ち)の確率で町を生やす。1tick内で複数駅を順に処理し、先に湧いた町を
  後続の駅の「近くに町が無いか」判定にも反映する(隣接駅で同時に何個も湧かないように)。
- 新しい町の生成そのもの(候補地の絞り込み・命名・人口レンジ)は旧`maybeSpawnTownForStation`
  の中身をそのまま`spawnTownNear`という非公開ヘルパーに移しただけで変えていない
  (`NEW_TOWN_POPULATION_MIN/MAX`=100〜400、駅から1〜3タイル、水域・山岳を避ける)。
- 駅名の自動命名(`construction.ts`の`stationNameFor`)は無改修。町が無い駅は既存の
  `nextStationName`(A駅/B駅…のフォールバック)がそのまま使われ、後から近くに町が湧いても
  駅名は自動では変わらない(旧仕様でも「駅名は建設時点で1回だけ決める」挙動だったため、
  範囲を広げず既存の割り切りを維持)。

## Alternatives considered

- 輸送力チェックを月次(既存のtownGrowthと同じタイミング)にする案 → 月1回だと「町が
  育つまで待たされている感」が強く、日単位のほうがゲーム内時間の体感に合う。仕様書の
  「既存の月次/日次ティックがあればそこに載せる」に従い、月次より粒度が細かい
  `dayIndexOf`を新設してそちらに載せた。
- 確率を非線形(指数など)にする案 → 「単純な線形で可」という指示どおり線形にとどめた。
  バランスは`TOWN_SPAWN_CAPACITY_THRESHOLD`/`TOWN_SPAWN_BASE_CHANCE`の2定数(towns.ts)に
  集約してあるので、後から調整しやすい。

## Constraints / Gotchas

- `stepWorld`の日次ループは`world.terrain`が無い(旧セーブ由来でterrainフィールドが
  無いケース)場合は丸ごとスキップする。町の湧き候補地選定に地形判定が必須のため
  (`terrainAt`が既定でgrass扱いにはなるが、意図的にterrain未設定のワールドでは湧かせない
  安全側の選択)。
- `computeStationTransportInfos`は`train.status==='running'`かつ運行表(`effectiveSchedule`、
  グループ所属なら共有運行表)にその駅idが含まれる列車だけを数える。車庫在籍中(stored)の
  列車は輸送力に数えない(=町が育つには実際に列車を走らせる必要がある)。
- セーブ互換: `TownData`/`StationData`のデータ形状は変更していないため、旧セーブの
  読み込みは無改修で動く(persistence.tsのマイグレーション不要)。挙動面では、旧セーブを
  読み込んで再開した直後は「駅はあるが町がまだ無い」状態になり得るが、それは新仕様として
  意図した状態(輸送力が育てば日次チェックで湧く)。
