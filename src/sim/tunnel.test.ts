import { describe, it, expect } from 'vitest';
import { toKey, DIR } from '../utils';
import type { CellData } from '../types';
import { tunnelPortals, isInTunnelInterior } from './tunnel';

describe('tunnelPortals', () => {
  it('直線トンネル3セルで坑口が両端の2つだけになる', () => {
    // (0,0)-(0,1)-(0,2) の南北直線。中間(0,1)は両隣ともtunnelなので坑口なし。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
      [toKey(0, 2), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);

    const portals = tunnelPortals(railMap);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1 },
        { x: 0, z: 2, dx: 0, dz: 1 },
      ])
    );
  });

  it('単セルトンネルは坑口が2つになる', () => {
    const railMap = new Map<string, CellData>([
      [toKey(5, 5), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
    ]);

    const portals = tunnelPortals(railMap);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 5, z: 5, dx: 0, dz: -1 },
        { x: 5, z: 5, dx: 0, dz: 1 },
      ])
    );
  });

  it('L字トンネルでも境界面(=非tunnel隣接方向)だけが坑口になる', () => {
    // (0,0)-(1,0)-(1,1) のL字。曲がり角(1,0)は両隣ともtunnelなので坑口なし。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.E, tunnel: true }],
      [toKey(1, 0), { type: 'rail', connections: DIR.W | DIR.S, tunnel: true }],
      [toKey(1, 1), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);

    const portals = tunnelPortals(railMap);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: -1, dz: 0 },
        { x: 1, z: 1, dx: 0, dz: 1 },
      ])
    );
  });

  it('非tunnelセルは坑口を持たない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);

    expect(tunnelPortals(railMap)).toEqual([]);
  });
});

describe('isInTunnelInterior', () => {
  it('tunnelセルの座標(四捨五入)ならtrueを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
    ]);

    expect(isInTunnelInterior(railMap, 3.2, 3.9)).toBe(true);
  });

  it('非tunnelセル・空セルはfalseを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);

    expect(isInTunnelInterior(railMap, 3, 4)).toBe(false);
    expect(isInTunnelInterior(railMap, 99, 99)).toBe(false);
  });
});
