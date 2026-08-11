import { describe, it, expect } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData } from '../types';
import { createTerrainField } from '../sim/terrainField';
import { buildRailNetworkGeometry } from './railGeometry';

const field = createTerrainField(1, 32);

describe('buildRailNetworkGeometry: 地平のみのセル', () => {
  it('地平の直線1本はsurfaceにレール・枕木・バラストを生成し、地下・開口は空', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.surface.rails).not.toBeNull();
    expect(geo.surface.sleepers).not.toBeNull();
    expect(geo.surface.ballast).not.toBeNull();
    expect(geo.surface.piers).toBeNull();
    expect(geo.surface.decks).toBeNull();
    expect(geo.undergroundBright.rails).toBeNull();
    expect(geo.undergroundDim.rails).toBeNull();
    expect(geo.openingPits).toBeNull();
    expect(geo.openingWalls).toBeNull();
  });
});

describe('buildRailNetworkGeometry: gauge省略時はbyte-identical', () => {
  it('gaugeフィールドを持たないセルは、旧セーブと同じposition配列を生成する', () => {
    const legacy = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const withUndefinedGauge = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, gauge: undefined }],
    ]);
    const geoLegacy = buildRailNetworkGeometry(legacy, field, false, 0);
    const geoUndef = buildRailNetworkGeometry(withUndefinedGauge, field, false, 0);
    expect(Array.from(geoUndef.surface.rails!.getAttribute('position')!.array))
      .toEqual(Array.from(geoLegacy.surface.rails!.getAttribute('position')!.array));
    expect(Array.from(geoUndef.surface.sleepers!.getAttribute('position')!.array))
      .toEqual(Array.from(geoLegacy.surface.sleepers!.getAttribute('position')!.array));
  });
});

describe('buildRailNetworkGeometry: electrified区間の架線', () => {
  it('electrified:trueのセルはcatenaryにマスト/電線を生成する', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, electrified: true }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.catenary.wires).not.toBeNull();
  });

  it('electrifiedでないセルはcatenaryを生成しない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.catenary.wires).toBeNull();
    expect(geo.catenary.masts).toBeNull();
  });

  it('PM3: electrified:"ac"のセルはcatenaryAcバケットへ、"dc"はcatenaryバケットへ振り分ける', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, electrified: 'dc' }],
      [toKey(1, 0), { type: 'rail', connections: DIR.N | DIR.S, electrified: 'ac' }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.catenary.wires).not.toBeNull();
    expect(geo.catenaryAc.wires).not.toBeNull();
  });

  it('PM3: 全セルdcならcatenaryAcは空のまま', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, electrified: 'dc' }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.catenaryAc.wires).toBeNull();
    expect(geo.catenaryAc.masts).toBeNull();
  });
});

describe('buildRailNetworkGeometry: 高架桁(uppers)', () => {
  it('レベル1の桁セルはsurfaceに枕木・レール・支柱/桁を生成する(バラストは敷かない)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.surface.rails).not.toBeNull();
    expect(geo.surface.sleepers).not.toBeNull();
    expect(geo.surface.decks).not.toBeNull();
  });
});

describe('buildRailNetworkGeometry: 地下(uppers負レベル)の可視性', () => {
  const railMap = new Map<string, CellData>([
    [toKey(0, 0), { type: 'rail', connections: 0, uppers: { '-1': { connections: DIR.N | DIR.S } } as any }],
  ]);

  // 0.5.0-Alpha-8e: 地上ビューの地下線ゴーストが「ごちゃごちゃして見づらい」との
  // ユーザーフィードバックを受け、地上ビューの地下線は完全に非表示にした
  // (以前はundergroundGhostバケットへ薄く透けて出していた)。
  it('通常表示(undergroundView=false)では地下線を一切生成しない', () => {
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.undergroundBright.rails).toBeNull();
    expect(geo.undergroundDim.rails).toBeNull();
  });

  it('地下ビュー中、選択レベルが一致すればbright、しなければdimに入る', () => {
    const bright = buildRailNetworkGeometry(railMap, field, true, -1);
    expect(bright.undergroundBright.rails).not.toBeNull();
    expect(bright.undergroundDim.rails).toBeNull();

    const dim = buildRailNetworkGeometry(railMap, field, true, -2);
    expect(dim.undergroundBright.rails).toBeNull();
    expect(dim.undergroundDim.rails).not.toBeNull();
  });
});

describe('buildRailNetworkGeometry: 掘割ランプの地表開口', () => {
  it('base=-1の坂は通常表示で開口(pit/wall)を生成するが、坂の線路自体は一切描かない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, ramp: { dir: DIR.N, base: -1, level: 1 } }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.openingPits).not.toBeNull();
    expect(geo.openingWalls).not.toBeNull();
    expect(geo.undergroundBright.rails).toBeNull();
    expect(geo.undergroundDim.rails).toBeNull();
  });
});
