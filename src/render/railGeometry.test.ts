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
    expect(geo.undergroundGhost.rails).toBeNull();
    expect(geo.openings).toBeNull();
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

  // 0.5.0-Alpha-4c: 地上ビューでも地下をゴーストとして描く(以前は完全に消えていた)。
  it('通常表示(undergroundView=false)では地下線をゴーストバケットへ入れる', () => {
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.undergroundGhost.rails).not.toBeNull();
    expect(geo.undergroundBright.rails).toBeNull();
    expect(geo.undergroundDim.rails).toBeNull();
  });

  it('地下ビュー中、選択レベルが一致すればbright、しなければdimに入る', () => {
    const bright = buildRailNetworkGeometry(railMap, field, true, -1);
    expect(bright.undergroundBright.rails).not.toBeNull();
    expect(bright.undergroundDim.rails).toBeNull();
    expect(bright.undergroundGhost.rails).toBeNull();

    const dim = buildRailNetworkGeometry(railMap, field, true, -2);
    expect(dim.undergroundBright.rails).toBeNull();
    expect(dim.undergroundDim.rails).not.toBeNull();
    expect(dim.undergroundGhost.rails).toBeNull();
  });
});

describe('buildRailNetworkGeometry: 掘割ランプの地表開口', () => {
  it('base=-1の坂は通常表示で開口(pit/wall)を生成し、坂の線路はゴーストで出す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, ramp: { dir: DIR.N, base: -1, level: 1 } }],
    ]);
    const geo = buildRailNetworkGeometry(railMap, field, false, 0);
    expect(geo.openings).not.toBeNull();
    expect(geo.undergroundGhost.rails).not.toBeNull();
    expect(geo.undergroundBright.rails).toBeNull();
    expect(geo.undergroundDim.rails).toBeNull();
  });
});
