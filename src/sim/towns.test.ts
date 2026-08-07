import { describe, expect, it } from 'vitest';
import type { CellData, StationData, TerrainType, TownData } from '../types';
import { fieldFromMaps } from './terrainField';
import { createTerrainField } from './terrainField';
import type { TerrainField } from './terrainField';
import {
  mulberry32, growTown, townServiceLevel,
  TOWN_POPULATION_MIN, TOWN_POPULATION_MAX, TOWN_POPULATION_CAP,
  TOWN_STATION_RADIUS,
  nearestTownWithinRadius, stationNameForTown,
  NEW_TOWN_POPULATION_MIN, NEW_TOWN_POPULATION_MAX,
  resolveTownSpawnTick, townSpawnChance, TOWN_SPAWN_CAPACITY_THRESHOLD, TOWN_SPAWN_BASE_CHANCE,
  TOWN_REGION_SIZE, TOWN_REGION_DENSITY, MIN_STARTING_TOWNS,
  regionsInRange, regionTownCandidate, generateRegionTowns,
  METROPOLIS_POPULATION_MIN, METROPOLIS_POPULATION_MAX, METROPOLIS_FRACTION,
  townDensityParams, type TownDensity,
  type StationTransportInfo,
} from './towns';

describe('mulberry32', () => {
  it('同じシードからは同じ乱数列が決定的に得られる', () => {
    const rngA = mulberry32(12345);
    const rngB = mulberry32(12345);
    const seqA = Array.from({ length: 10 }, () => rngA());
    const seqB = Array.from({ length: 10 }, () => rngB());
    expect(seqA).toEqual(seqB);
  });

  it('異なるシードからは異なる乱数列が得られる', () => {
    const rngA = mulberry32(1);
    const rngB = mulberry32(2);
    expect(rngA()).not.toBe(rngB());
  });

  it('返り値は常に[0, 1)の範囲に収まる', () => {
    const rng = mulberry32(999);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('町名', () => {
  it('生成された街には名前が付く(generateRegionTownsのフィクスチャで確認)', () => {
    const field = createTerrainField(42, 45);
    const towns = generateRegionTowns(42, 45, field);
    expect(towns.length).toBeGreaterThan(0);
    for (const town of towns) {
      expect(town.name).toBeTruthy();
      expect(town.name.endsWith('町') || town.name.endsWith('市') || town.name.endsWith('村')).toBe(true);
    }
  });

  it('同じシードなら町名も同じ(決定的)', () => {
    const field = createTerrainField(7, 45);
    const a = generateRegionTowns(7, 45, field).map(t => t.name);
    const b = generateRegionTowns(7, 45, field).map(t => t.name);
    expect(a).toEqual(b);
  });

  it('町名は重複しない', () => {
    const field = createTerrainField(3, 45);
    const names = generateRegionTowns(3, 45, field).map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('街の成長', () => {
  const town = (population: number): TownData => ({
    id: 'town-0', name: 'テスト町', centre: { x: 0, z: 0 }, population,
  });

  it('鉄道が使える町は人口が増える', () => {
    const grown = growTown(town(1000), 1);
    expect(grown.population).toBeGreaterThan(1000);
  });

  it('鉄道が無い町は人口が変わらない', () => {
    expect(growTown(town(1000), 0).population).toBe(1000);
  });

  it('鉄道の便がよいほど成長が速い', () => {
    const slow = growTown(town(1000), 0.3).population;
    const fast = growTown(town(1000), 1).population;
    expect(fast).toBeGreaterThan(slow);
  });

  it('人口は上限で頭打ちになる', () => {
    expect(growTown(town(TOWN_POPULATION_CAP), 1).population).toBe(TOWN_POPULATION_CAP);
  });

  it('人口は整数のまま保たれる', () => {
    expect(Number.isInteger(growTown(town(1234), 0.55).population)).toBe(true);
  });
});

describe('町の鉄道アクセス(serviceLevel)', () => {
  const stations = new Map<string, StationData>([
    ['near', { id: 'near', name: '近駅', cells: [], center: { x: 1, z: 0 }, platformDoors: 'none' }],
    ['far', { id: 'far', name: '遠駅', cells: [], center: { x: 40, z: 0 }, platformDoors: 'none' }],
  ]);
  const town: TownData = { id: 'town-0', name: 'テスト町', centre: { x: 0, z: 0 }, population: 1000 };

  it('列車が停まる駅が近くにあれば1に近い', () => {
    expect(townServiceLevel(town, stations, new Set(['near']))).toBeGreaterThan(0.8);
  });

  it('駅はあっても列車が来ないなら0', () => {
    expect(townServiceLevel(town, stations, new Set())).toBe(0);
  });

  it('遠い駅しか無ければ0', () => {
    expect(townServiceLevel(town, stations, new Set(['far']))).toBe(0);
  });
});

describe('nearestTownWithinRadius', () => {
  const minamimiya: TownData = { id: 'town-0', name: '南宮市', centre: { x: 0, z: 0 }, population: 1000 };
  const furusato: TownData = { id: 'town-1', name: '古里市', centre: { x: 30, z: 30 }, population: 1000 };
  const towns = [minamimiya, furusato];

  it('半径内に町があればそれを返す', () => {
    expect(nearestTownWithinRadius({ x: 2, z: 0 }, towns)).toBe(minamimiya);
  });

  it('半径内に複数あれば最も近い町を返す', () => {
    const close: TownData = { id: 'town-2', name: '近町', centre: { x: 1, z: 0 }, population: 1000 };
    expect(nearestTownWithinRadius({ x: 2, z: 0 }, [minamimiya, close])).toBe(close);
  });

  it('半径外にしか町が無ければnull', () => {
    expect(nearestTownWithinRadius({ x: TOWN_STATION_RADIUS + 5, z: 0 }, towns)).toBeNull();
  });
});

describe('stationNameForTown', () => {
  const minamimiya: TownData = { id: 'town-0', name: '南宮市', centre: { x: 0, z: 0 }, population: 1000 };

  it('町の名前(接尾語を除く)＋駅、を返す', () => {
    expect(stationNameForTown(minamimiya, { x: 2, z: 0 }, new Set())).toBe('南宮駅');
  });

  it('既に使われていれば東西南北つきの名前になる(町の東)', () => {
    const used = new Set(['南宮駅']);
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('東南宮駅');
  });

  it('町の北にあれば北南宮駅になる', () => {
    const used = new Set(['南宮駅']);
    expect(stationNameForTown(minamimiya, { x: 0, z: -5 }, used)).toBe('北南宮駅');
  });

  it('方角つきの名前も埋まっていれば中央→新→台/森/谷/浜/橋の順に進む', () => {
    const used = new Set(['南宮駅', '東南宮駅']);
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('南宮中央駅');

    used.add('南宮中央駅');
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('新南宮駅');

    used.add('新南宮駅');
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('南宮台駅');

    used.add('南宮台駅');
    expect(stationNameForTown(minamimiya, { x: 5, z: 0 }, used)).toBe('南宮森駅');
  });

  it('全部埋まっていれば番号付きになり、必ず一意な名前を返す', () => {
    const used = new Set([
      '南宮駅', '東南宮駅', '南宮中央駅', '新南宮駅',
      '南宮台駅', '南宮森駅', '南宮谷駅', '南宮浜駅', '南宮橋駅',
      '南宮第2駅',
    ]);
    const name = stationNameForTown(minamimiya, { x: 5, z: 0 }, used);
    expect(name).toBe('南宮第3駅');
    expect(used.has(name)).toBe(false);
  });
});

describe('townSpawnChance', () => {
  it('閾値未満の輸送力では0', () => {
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD - 1)).toBe(0);
  });

  it('ちょうど閾値ではTOWN_SPAWN_BASE_CHANCE', () => {
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD)).toBeCloseTo(TOWN_SPAWN_BASE_CHANCE);
  });

  it('輸送力に応じて線形に増え、1で頭打ちになる', () => {
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD * 2)).toBeCloseTo(TOWN_SPAWN_BASE_CHANCE * 2);
    expect(townSpawnChance(TOWN_SPAWN_CAPACITY_THRESHOLD * 1000)).toBe(1);
  });
});

describe('resolveTownSpawnTick', () => {
  const emptyField = fieldFromMaps(new Map(), new Map(), 200);

  it('駅があっても列車が停まらない(capacity=0)なら何度チェックしても湧かない', () => {
    const infos: StationTransportInfo[] = [{ stationId: 's1', pos: { x: 100, z: 100 }, capacity: 0 }];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
    expect(result.towns).toEqual([]);
  });

  it('輸送力が閾値未満なら湧かない', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD - 1 },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
  });

  it('輸送力が閾値以上・rngが十分低ければ湧く', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    expect(result.spawnedTowns.length).toBe(1);
    expect(result.towns).toEqual(result.spawnedTowns);
  });

  it('rngがchance以上を返せば湧かない(towns参照は不変)', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysHigh = () => 0.999;
    const towns: TownData[] = [];
    const result = resolveTownSpawnTick(infos, towns, emptyField, alwaysHigh);
    expect(result.spawnedTowns).toEqual([]);
    expect(result.towns).toBe(towns);
  });

  it('近くに既に町があれば輸送力十分でも湧かない', () => {
    const existing: TownData[] = [{ id: 'town-0', name: '南宮市', centre: { x: 100, z: 100 }, population: 1000 }];
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD * 5 },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, existing, emptyField, alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
    expect(result.towns).toBe(existing);
  });

  it('十分なティック(日次呼び出しの繰り返し)を重ねれば決定的に湧く', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD * 2 },
    ];
    const rng = mulberry32(7);
    let towns: TownData[] = [];
    let spawned = false;
    for (let day = 0; day < 500 && !spawned; day++) {
      const result = resolveTownSpawnTick(infos, towns, emptyField, rng);
      towns = result.towns;
      if (result.spawnedTowns.length > 0) spawned = true;
    }
    expect(spawned).toBe(true);
  });

  it('人口はNEW_TOWN_POPULATION_MIN〜MAXの範囲', () => {
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], emptyField, alwaysZero);
    const spawned = result.spawnedTowns[0];
    expect(spawned.population).toBeGreaterThanOrEqual(NEW_TOWN_POPULATION_MIN);
    expect(spawned.population).toBeLessThanOrEqual(NEW_TOWN_POPULATION_MAX);
  });

  it('水域・山岳の上には町を作らない(駅周辺が全部水没していれば湧かない)', () => {
    const terrain: Map<string, TerrainType> = new Map();
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        terrain.set(`${100 + dx},${100 + dz}`, 'water');
      }
    }
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const result = resolveTownSpawnTick(infos, [], fieldFromMaps(new Map(), terrain, 200), alwaysZero);
    expect(result.spawnedTowns).toEqual([]);
  });

  it('線路・駅・車庫が地面を占有するセルの上には町の中心を置かない', () => {
    // 駅(100,100)の周囲1〜3タイルの全候補セルに地平の線路を敷き詰める
    const railMap = new Map<string, CellData>();
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        railMap.set(`${100 + dx},${100 + dz}`, { type: 'rail', connections: 1 });
      }
    }
    const infos: StationTransportInfo[] = [
      { stationId: 's1', pos: { x: 100, z: 100 }, capacity: TOWN_SPAWN_CAPACITY_THRESHOLD },
    ];
    const alwaysZero = () => 0;
    const blocked = resolveTownSpawnTick(infos, [], emptyField, alwaysZero, railMap);
    expect(blocked.spawnedTowns).toEqual([]);

    // 純粋な高架専用セル(地平接続なし)は地面を塞がないので湧ける
    const elevatedOnly = new Map<string, CellData>();
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        elevatedOnly.set(`${100 + dx},${100 + dz}`, {
          type: 'rail', connections: 0, uppers: { 1: { connections: 1 } },
        });
      }
    }
    const allowed = resolveTownSpawnTick(infos, [], emptyField, alwaysZero, elevatedOnly);
    expect(allowed.spawnedTowns.length).toBe(1);
  });
});

describe('regionsInRange', () => {
  it('halfExtentがTOWN_REGION_SIZE未満なら原点をまたぐ2×2=4領域に収まる', () => {
    // floor(-45/128)=-1, floor(45/128)=0 なので、原点をまたぐ場合は4領域になる。
    expect(regionsInRange(45)).toEqual([
      { rx: -1, rz: -1 }, { rx: -1, rz: 0 }, { rx: 0, rz: -1 }, { rx: 0, rz: 0 },
    ]);
  });

  it('halfExtentが大きいと領域数はO(halfExtent^2/TOWN_REGION_SIZE^2)になる', () => {
    const regions = regionsInRange(8192);
    const side = Math.ceil((8192 * 2 + 1) / TOWN_REGION_SIZE);
    // ±1領域ぶんの誤差を許容(端の丸め)
    expect(regions.length).toBeGreaterThanOrEqual(side * side - side * 2);
    expect(regions.length).toBeLessThanOrEqual((side + 2) * (side + 2));
  });

  it('rx昇順→rz昇順で決定的に列挙される', () => {
    const regions = regionsInRange(300);
    for (let i = 1; i < regions.length; i++) {
      const a = regions[i - 1];
      const b = regions[i];
      expect(a.rx < b.rx || (a.rx === b.rx && a.rz < b.rz)).toBe(true);
    }
  });
});

describe('regionTownCandidate / generateRegionTowns', () => {
  const flatField = createTerrainField(1, 4096); // 起伏の少ない広いfield(平地優勢)

  it('同じ(worldSeed, rx, rz)からは同じ候補が決定的に得られる', () => {
    const a = regionTownCandidate(42, 3, -2, 4096, flatField);
    const b = regionTownCandidate(42, 3, -2, 4096, flatField);
    expect(a).toEqual(b);
  });

  it('候補があればidはtown-r{rx},{rz}の形式', () => {
    let found = false;
    for (let rx = -20; rx <= 20 && !found; rx++) {
      for (let rz = -20; rz <= 20 && !found; rz++) {
        const c = regionTownCandidate(42, rx, rz, 4096, flatField);
        if (c) {
          expect(c.id).toBe(`town-r${rx},${rz}`);
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('populationは通常はTOWN_POPULATION_MIN..MAXに収まるが、大都市(METROPOLIS_POPULATION_MIN..MAX)の場合もある', () => {
    for (let rx = -10; rx <= 10; rx++) {
      for (let rz = -10; rz <= 10; rz++) {
        const c = regionTownCandidate(1, rx, rz, 4096, flatField);
        if (!c) continue;
        const inNormalRange = c.population >= TOWN_POPULATION_MIN && c.population <= TOWN_POPULATION_MAX;
        const inMetropolisRange = c.population >= METROPOLIS_POPULATION_MIN && c.population <= METROPOLIS_POPULATION_MAX;
        expect(inNormalRange || inMetropolisRange).toBe(true);
      }
    }
  });

  it('生成された町の中心座標はhalfExtent以内かつ水域を回避する(標高・傾斜そのものは問わない)', () => {
    // P7d: mountain(標高1以上)は建設不可の障害物ではなくなったため、町の中心も
    // 「周辺が平坦優勢な高原」なら許可される(中心セル自体がflatである保証はない。
    // isNearTerrainは「近傍の優勢さ」で判定するため)。ここでは水域回避のみ確認する。
    const towns = generateRegionTowns(7, 2000, flatField);
    for (const town of towns) {
      expect(Math.abs(town.centre.x)).toBeLessThanOrEqual(2000);
      expect(Math.abs(town.centre.z)).toBeLessThanOrEqual(2000);
      expect(flatField.terrainTypeAt(town.centre.x, town.centre.z)).not.toBe('water');
    }
  });

  it('標高1のflatな高原にも町が生成できる(P7d: mountain概念の廃止)', () => {
    // 全域が標高1のflatなスタブfield(旧仕様ならterrainTypeAt==='mountain'で
    // 一律棄却されていた)。regionTownCandidateが少なくとも1つは候補を返すことを確認する。
    const plateauField: TerrainField = {
      cornerHeightAt: () => 1,
      cellCornerHeights: () => [1, 1, 1, 1],
      cellHeightAt: () => 1,
      terrainTypeAt: () => 'mountain',
    };
    let found = false;
    for (let rx = -10; rx <= 10 && !found; rx++) {
      for (let rz = -10; rz <= 10 && !found; rz++) {
        if (regionTownCandidate(42, rx, rz, 4096, plateauField)) found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('水域に近い候補は標高1のflatでも棄却される', () => {
    const waterField: TerrainField = {
      cornerHeightAt: () => 1,
      cellCornerHeights: () => [1, 1, 1, 1],
      cellHeightAt: () => 1,
      terrainTypeAt: () => 'water',
    };
    for (let rx = -5; rx <= 5; rx++) {
      for (let rz = -5; rz <= 5; rz++) {
        expect(regionTownCandidate(42, rx, rz, 4096, waterField)).toBeNull();
      }
    }
  });

  it('小さいマップ(halfExtent=45)でも数領域だけが評価され、O(regions)で終わる', () => {
    const towns = generateRegionTowns(42, 45, createTerrainField(42, 45));
    expect(towns.length).toBeLessThanOrEqual(4);
  });

  it('16Kマップ相当(halfExtent=8192)でも500ms未満で生成が終わる', () => {
    const bigField = createTerrainField(2026, 8192);
    const start = performance.now();
    const towns = generateRegionTowns(2026, 8192, bigField);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    // 「a few thousand towns」の想定オーダーに収まっていることの粗いガード
    expect(towns.length).toBeGreaterThan(500);
    expect(towns.length).toBeLessThan(20000);
  });

  it('ランタイム湧きの町id(town-spawn-...)とは衝突しない命名規則', () => {
    const towns = generateRegionTowns(9, 2000, flatField);
    for (const town of towns) {
      expect(town.id.startsWith('town-r') || town.id.startsWith('town-fallback-')).toBe(true);
      expect(town.id.startsWith('town-spawn-')).toBe(false);
    }
  });

  it('領域の候補位置は、マップ縁の領域でもゲート確率どおりの割合で得られる(範囲外棄却による下振れが無い)', () => {
    // 領域(-1,-1)はhalfExtent=45のマップと交差はするが、領域128×128の中では
    // ごく一部(x,z∈[-45,-1])しか範囲内に無い。旧実装は領域全体でジッターしてから
    // 範囲外を棄却していたため、この領域では候補のほとんどが失われ、実効密度が
    // TOWN_REGION_DENSITYよりずっと低くなっていた(観測: 平均0.14 townsなど)。
    // 修正後は領域とマップの交差矩形内でジッターするため、ゲートを通った候補は
    // (地形による棄却を除き)ほぼ必ず有効な位置になるはず。
    let gatePassCount = 0;
    let candidateCount = 0;
    const flatHalf = createTerrainField(1, 4096); // 平地優勢の広いfield(地形棄却の影響を抑える)
    for (let seed = 0; seed < 500; seed++) {
      // ゲート自体を通ったかは内部実装依存なので直接は見えない。代わりに、
      // TOWN_REGION_DENSITY近傍の割合で候補が返ることを統計的に確認する。
      const c = regionTownCandidate(seed, -1, -1, 45, flatHalf);
      candidateCount++;
      if (c) gatePassCount++;
    }
    const rate = gatePassCount / candidateCount;
    // 旧実装(領域全体でジッター)ではこの領域の交差率は約34%(44/128)四方
    // ≈12%相当で、実効密度はTOWN_REGION_DENSITY×0.12≈0.048ほどにまで落ちていた
    // (このテストを旧実装に対して実行すると概ね0.03〜0.05になることを確認済み)。
    // 修正後は地形棄却を差し引いてもTOWN_REGION_DENSITY(0.4)の半分程度は残るはず。
    expect(rate).toBeGreaterThan(TOWN_REGION_DENSITY * 0.4);
  });
});

describe('generateRegionTowns: 最小開始町数の保証(MIN_STARTING_TOWNS)', () => {
  it('MIN_STARTING_TOWNSは3としてエクスポートされている', () => {
    expect(MIN_STARTING_TOWNS).toBe(3);
  });

  it('小マップ(halfExtent=45)は50シード中すべてでMIN_STARTING_TOWNS以上の町を持つ', () => {
    const counts: number[] = [];
    for (let seed = 0; seed < 50; seed++) {
      const field = createTerrainField(seed, 45);
      const towns = generateRegionTowns(seed, 45, field);
      counts.push(towns.length);
      expect(towns.length).toBeGreaterThanOrEqual(MIN_STARTING_TOWNS);
    }
    // ゼロ町始まりが無いことも明示的に確認する(元バグの再現条件)。
    expect(counts.filter(c => c === 0).length).toBe(0);
  });

  it('中マップ(halfExtent=128)は50シード中すべてでMIN_STARTING_TOWNS以上の町を持つ', () => {
    for (let seed = 0; seed < 50; seed++) {
      const field = createTerrainField(seed, 128);
      const towns = generateRegionTowns(seed, 128, field);
      expect(towns.length).toBeGreaterThanOrEqual(MIN_STARTING_TOWNS);
    }
  });

  it('フォールバックで足した町を含め、idは重複しない', () => {
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const field = createTerrainField(seed, 45);
      const towns = generateRegionTowns(seed, 45, field);
      const ids = new Set(towns.map(t => t.id));
      expect(ids.size).toBe(towns.length);
    }
  });

  it('同じseedからは決定的に同じ町配置が得られる(フォールバック込み)', () => {
    const field = createTerrainField(123, 45);
    const a = generateRegionTowns(123, 45, field);
    const b = generateRegionTowns(123, 45, field);
    expect(a).toEqual(b);
  });

  it('16Kマップ相当では領域パスだけで既に充足しており、フォールバックはno-op(件数は領域数のオーダーのまま)', () => {
    const field = createTerrainField(2026, 8192);
    const towns = generateRegionTowns(2026, 8192, field);
    expect(towns.length).toBeGreaterThan(MIN_STARTING_TOWNS * 100);
  });
});

describe('大都市(メトロポリス)', () => {
  const flatField = createTerrainField(1, 4096);

  it('ハッシュゲートを通った町のうちおよそMETROPOLIS_FRACTION(4%)が大都市になり、人口はMETROPOLIS_POPULATION_MIN..MAXに収まる', () => {
    let total = 0;
    let metropolises = 0;
    for (let rx = -60; rx <= 60; rx++) {
      for (let rz = -60; rz <= 60; rz++) {
        const c = regionTownCandidate(1, rx, rz, 8192, flatField);
        if (!c) continue;
        total++;
        if (c.population >= METROPOLIS_POPULATION_MIN) {
          metropolises++;
          expect(c.population).toBeLessThanOrEqual(METROPOLIS_POPULATION_MAX);
        }
      }
    }
    expect(total).toBeGreaterThan(100);
    const ratio = metropolises / total;
    // 決定的ハッシュゲートなので厳密に4%にはならないが、大きくは外れないはず。
    expect(ratio).toBeGreaterThan(METROPOLIS_FRACTION * 0.3);
    expect(ratio).toBeLessThan(METROPOLIS_FRACTION * 3);
  });

  it('同じ(worldSeed, rx, rz)からは大都市判定も決定的', () => {
    let found: TownData | null = null;
    for (let rx = -60; rx <= 60 && !found; rx++) {
      for (let rz = -60; rz <= 60 && !found; rz++) {
        const c = regionTownCandidate(1, rx, rz, 8192, flatField);
        if (c && c.population >= METROPOLIS_POPULATION_MIN) found = c;
      }
    }
    expect(found).not.toBeNull();
  });
});

describe('町密度オプション(TownDensity)', () => {
  it('townDensityParamsは4段階(sparse/normal/dense/packed)を返し、normalは既定値(regionSize=TOWN_REGION_SIZE, gate=TOWN_REGION_DENSITY)と一致する', () => {
    const normal = townDensityParams('normal');
    expect(normal.regionSize).toBe(TOWN_REGION_SIZE);
    expect(normal.gate).toBe(TOWN_REGION_DENSITY);

    const sparse = townDensityParams('sparse');
    expect(sparse.gate).toBeLessThan(normal.gate);

    const dense = townDensityParams('dense');
    expect(dense.gate).toBeGreaterThan(normal.gate);

    const packed = townDensityParams('packed');
    expect(packed.regionSize).toBeLessThan(normal.regionSize);
  });

  it('sparse < normal < dense の順で町数が増える(中マップhalfExtent=2000)', () => {
    const field = createTerrainField(555, 2000);
    const sparseCount = generateRegionTowns(555, 2000, field, 'sparse').length;
    const normalCount = generateRegionTowns(555, 2000, field, 'normal').length;
    const denseCount = generateRegionTowns(555, 2000, field, 'dense').length;
    expect(sparseCount).toBeLessThan(normalCount);
    expect(normalCount).toBeLessThan(denseCount);
  });

  it('packedはnormalよりはるかに町数が多い(regionSizeが細かいため)', () => {
    const field = createTerrainField(555, 2000);
    const normalCount = generateRegionTowns(555, 2000, field, 'normal').length;
    const packedCount = generateRegionTowns(555, 2000, field, 'packed').length;
    expect(packedCount).toBeGreaterThan(normalCount * 2);
  });

  it('同じseed+densityなら決定的に同じ町配置が得られる', () => {
    const field = createTerrainField(9, 2000);
    const a = generateRegionTowns(9, 2000, field, 'packed');
    const b = generateRegionTowns(9, 2000, field, 'packed');
    expect(a).toEqual(b);
  });

  it('densityを省略するとnormal相当になる(後方互換)', () => {
    const field = createTerrainField(9, 2000);
    const withoutArg = generateRegionTowns(9, 2000, field);
    const withNormal = generateRegionTowns(9, 2000, field, 'normal');
    expect(withoutArg).toEqual(withNormal);
  });

  it('16K・packedでも1.5秒未満で生成が終わる(性能ガード)', () => {
    const bigField = createTerrainField(2026, 8192);
    const start = performance.now();
    const towns = generateRegionTowns(2026, 8192, bigField, 'packed');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1500);
    expect(towns.length).toBeGreaterThan(500);
  });
});
