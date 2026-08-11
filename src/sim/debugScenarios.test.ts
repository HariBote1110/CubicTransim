import { describe, expect, it } from 'vitest';
import { toKey } from '../utils';
import { DEBUG_SCENARIOS } from './debugScenarios';
import { effectiveSchedule } from './groups';
import { stepWorld } from './simulation';
import type { SimWorld } from './simulation';
import { buildTownTileIndex } from './townTiles';
import { createTerrainField, fieldFromMaps } from './terrainField';
import { cornerDiffsFromField } from './terrainOverlay';

const scenario = (id: string) => {
  const def = DEBUG_SCENARIOS.find(s => s.id === id);
  if (!def) throw new Error(`シナリオ ${id} が見つかりません`);
  return def;
};

describe('DEBUG_SCENARIOS: カタログ', () => {
  it('idは一意で、日本語のラベルと一行説明を持つ', () => {
    const ids = DEBUG_SCENARIOS.map(s => s.id);
    expect(new Set(ids).size).toBe(DEBUG_SCENARIOS.length);
    expect(DEBUG_SCENARIOS.length).toBe(7);
    for (const s of DEBUG_SCENARIOS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('既存の「坂・高架・往復列車」が先頭に残っている', () => {
    expect(DEBUG_SCENARIOS[0].id).toBe('slopes-elevated-shuttle');
    expect(DEBUG_SCENARIOS[0].label).toBe('坂・高架・往復列車');
  });
});

describe('DEBUG_SCENARIOS: 各シナリオの不変条件', () => {
  for (const def of DEBUG_SCENARIOS) {
    it(`${def.label}: 列車は実在セルの上に居り、運行表の駅は実在し、1秒進めても例外を投げない`, () => {
      const world = def.build();

      for (const train of world.trains) {
        const cell = world.railMap.get(toKey(train.x, train.z));
        expect(cell, `${train.id} の初期位置にセルが無い`).toBeDefined();
        const schedule = effectiveSchedule(train, world.groups ?? []);
        expect(schedule.length).toBeGreaterThanOrEqual(2);
        for (const stationId of schedule) {
          expect(world.stations.has(stationId), `${train.id} の運行表の駅 ${stationId} が実在しない`).toBe(true);
        }
      }

      if (world.trains.length > 0) {
        const sim: SimWorld = {
          railMap: world.railMap,
          stations: world.stations,
          trains: world.trains,
          runtimes: new Map(),
          waiting: new Map(),
          rng: () => 0.5,
          towns: world.towns ?? [],
          terrainField: world.field,
          groups: world.groups,
        };
        expect(() => {
          for (let i = 0; i < 10; i++) stepWorld(sim, 0.1);
        }).not.toThrow();
      }
    });
  }

  it('多層高架と立体交差: Lv1〜Lv3の桁と坂があり、レベルごとに列車が居る', () => {
    const world = scenario('multi-level-crossing').build();
    const cells = Array.from(world.railMap.values());
    for (const level of [1, 2, 3] as const) {
      expect(cells.some(c => !!c.uppers?.[level])).toBe(true);
    }
    expect(cells.some(c => !!c.ramp)).toBe(true);
    expect(world.trains.length).toBe(4); // 地平1 + 高架3レベル
  });

  it('山岳トンネル: トンネル内部セルと坑口の両側があり、地形fieldを上書きする', () => {
    const world = scenario('mountain-tunnel').build();
    expect(world.field).toBeDefined();
    expect(world.field!.terrainTypeAt(0, 0)).toBe('mountain');
    const tunnelCells = Array.from(world.railMap.entries()).filter(([, c]) => c.tunnel);
    expect(tunnelCells.length).toBeGreaterThanOrEqual(3);
  });

  // R4末: wgpuレンダラーはseed+halfExtentからしか地形を作れないため、シナリオの
  // 手組みfieldはcornerDiffsFromField(useGameLogic.loadDebugScenario)でオーバーレイ
  // 差分へ焼き直して転送する。その変換はfield.cornerHeightAtだけを読むので、
  // cornerHeightAtがcellCornerHeights(尾根)と矛盾する値(常に0=平坦)を返すと、
  // 転送先には尾根が一切現れず、ブラウザで山が描画されない不具合になっていた。
  it('山岳トンネル: cornerHeightAtが尾根の標高を返し、オーバーレイ転送後も尾根が平坦化しない', () => {
    const world = scenario('mountain-tunnel').build();
    const field = world.field!;
    // 尾根の内側(x=0)は標高1、尾根の外側(x=6)は標高0であるべき
    // (terrainTypeAt(0,0)==='mountain'と矛盾しないように、cornerHeightAtも
    // 尾根の位置で高さを持たなければならない)。
    expect(field.cornerHeightAt(0, 0)).toBeGreaterThan(0);
    expect(field.cornerHeightAt(6, 0)).toBe(0);

    const diffs = cornerDiffsFromField(field, 16);
    // 転送後のオーバーレイにも尾根の標高(0より大きい値)が残っていること。
    const heights = [...diffs.values()].flatMap(chunk => [...chunk.values()]);
    expect(heights.some(h => h > 0)).toBe(true);
  });

  // なだらかな1段差はP7b以降の勾配追従(incline)でそのまま登れてしまい、
  // 「トンネルが必要な急峻な尾根」に見えない(見た目上も1色の帯にしか見えず、
  // ブラウザで「山に見えない」と報告された)。中心が高く両端で0まで落ちる
  // 三角形断面(ピーク型)にして、実際に隆起した尾根のシルエットになるようにする。
  it('山岳トンネル: cornerHeightAtは尾根の中心が最も高く、両端でなだらかに0へ落ちる山型になる', () => {
    const world = scenario('mountain-tunnel').build();
    const field = world.field!;
    const centre = field.cornerHeightAt(0, 0);
    expect(centre).toBeGreaterThan(1); // 1段だけの平らな帯ではなく、山らしい高さを持つ
    expect(field.cornerHeightAt(1, 0)).toBeLessThan(centre);
    expect(field.cornerHeightAt(-1, 0)).toBe(field.cornerHeightAt(1, 0)); // 左右対称
    expect(field.cornerHeightAt(3, 0)).toBe(0);
    expect(field.cornerHeightAt(-3, 0)).toBe(0);
  });

  // progress/wgpu-corner-override-z-investigation.md: wgpuレンダラー側のバイト単位検証
  // (ネイティブ・ブラウザ双方)により、|z|が大きい範囲でオーバーレイが反映されない
  // という不具合は存在しないことが判明した。z=-4..4へ絞るfieldBoundsの回避策は
  // 不要になったため、尾根自体をz依存の局所的な丘にして撤去する。
  it('山岳トンネル: cornerHeightAtは|z|>4で0に落ちる局所的な丘になり、fieldBoundsは使わない', () => {
    const world = scenario('mountain-tunnel').build();
    const field = world.field!;
    expect(field.cornerHeightAt(0, 0)).toBe(3);
    expect(field.cornerHeightAt(0, 4)).toBe(3);
    expect(field.cornerHeightAt(0, 10)).toBe(0);
    expect(world.fieldBounds).toBeUndefined();
  });

  it('単線行き違い: 信号3基と対向2列車を持つ', () => {
    const world = scenario('passing-loop').build();
    const signals = Array.from(world.railMap.values()).filter(c => c.signalDir !== undefined);
    expect(signals.length).toBe(3);
    expect(world.trains.length).toBe(2);
  });

  it('分岐と運用グループ: 運用グループがあり、所属列車の運行表はグループ経由で解決する', () => {
    const world = scenario('junction-groups').build();
    expect(world.groups?.length).toBe(1);
    const grouped = world.trains.find(t => t.groupId);
    expect(grouped).toBeDefined();
    expect(effectiveSchedule(grouped!, world.groups!)).toEqual(world.groups![0].schedule);
  });

  it('大都市と踏切: 人口50000の町があり、線路が市街地の道路タイルを複数横切る(踏切)', () => {
    const world = scenario('metropolis-crossings').build();
    expect(world.towns?.length).toBe(1);
    expect(world.towns![0].population).toBe(50_000);

    const tiles = buildTownTileIndex(world.towns!, fieldFromMaps(new Map(), new Map(), 45), world.railMap);
    let crossings = 0;
    for (const [key, cell] of world.railMap) {
      if (cell.type !== 'rail') continue;
      if (tiles.get(key)?.kind === 'road') crossings++;
    }
    expect(crossings).toBeGreaterThanOrEqual(3);
  });

  it('地形編集の遊び場: 線路・町なし、起伏のある地形(通常の乱数field)と最大の所持金を持つ', () => {
    const world = scenario('terrain-playground').build();
    expect(world.railMap.size).toBe(0);
    expect(world.trains.length).toBe(0);
    expect(world.towns).toEqual([]);
    expect(world.worldSeedOverride).toBeDefined();
    const field = createTerrainField(world.worldSeedOverride!, 45);
    let hasRelief = false;
    for (let x = -10; x <= 10 && !hasRelief; x++) {
      for (let z = -10; z <= 10 && !hasRelief; z++) {
        if (field.cellHeightAt(x, z) > 0) hasRelief = true;
      }
    }
    expect(hasRelief).toBe(true);
    expect(world.money).toBeGreaterThan(0);
  });
});
