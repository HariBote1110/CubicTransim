import { describe, it, expect } from 'vitest';
import { toKey, DIR } from '../utils';
import type { CellData } from '../types';
import {
  tunnelPortals, isInTunnelInterior, elevatedTunnelPortals, isInElevatedTunnelInterior,
} from './tunnel';

describe('tunnelPortals', () => {
  it('直線トンネル3セルで坑口が両端の2つだけになる', () => {
    // (0,0)-(0,1)-(0,2) の南北直線。中間(0,1)は両隣ともtunnelなので坑口なし。
    // 両端の外側((0,-1)/(0,3))は未登録(=非mountain、標高0)なので坑口が立つ。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N | DIR.S, tunnel: true }],
      [toKey(0, 2), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

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
    const elevation = new Map<string, number>();

    expect(tunnelPortals(railMap, elevation)).toEqual([]);
  });

  it('山の内部(行き止まり方向の隣接セルもmountain)で終端するレールは行き止まり坑口を作らない', () => {
    // (0,0)は南へ1方向だけ接続。行き止まり方向(北)の隣接セル(0,-1)がmountain(標高2)
    // ならまだ山の中なので、そこに坑口を立てるべきではない。
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, -1), 2]]);

    const portals = tunnelPortals(railMap, elevation);

    // (0,0)の北側(行き止まり方向)には坑口が立たない。(0,1)の南側は非mountainなので立つ。
    expect(portals).toEqual([{ x: 0, z: 1, dx: 0, dz: 1 }]);
  });

  it('山肌(行き止まり方向の隣接セルが非mountain)で終端する場合は坑口を作る', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.S, tunnel: true }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N, tunnel: true }],
    ]);
    // (0,-1)は未登録=非mountain(標高0)なので山肌。
    const elevation = new Map<string, number>();

    const portals = tunnelPortals(railMap, elevation);

    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1 },
        { x: 0, z: 1, dx: 0, dz: 1 },
      ])
    );
    expect(portals).toHaveLength(2);
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

describe('elevatedTunnelPortals', () => {
  it('標高がlevel未満(=山の内部でない)高架セルは坑口を持たない(通常の高架として扱う)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 0]]);

    expect(elevatedTunnelPortals(railMap, elevation, 1)).toEqual([]);
  });

  it('単セルの高架トンネル(標高がlevel以上)は坑口が2つになる', () => {
    const railMap = new Map<string, CellData>([
      [toKey(5, 5), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(5, 5), 1]]);

    const portals = elevatedTunnelPortals(railMap, elevation, 1);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 5, z: 5, dx: 0, dz: -1, level: 1 },
        { x: 5, z: 5, dx: 0, dz: 1, level: 1 },
      ])
    );
  });

  it('直線の高架トンネル3セルで坑口が両端の2つだけになる', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.S } } }],
      [toKey(0, 1), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
      [toKey(0, 2), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N } } }],
    ]);
    const elevation = new Map<string, number>([
      [toKey(0, 0), 1], [toKey(0, 1), 1], [toKey(0, 2), 1],
    ]);

    const portals = elevatedTunnelPortals(railMap, elevation, 1);

    expect(portals).toHaveLength(2);
    expect(portals).toEqual(
      expect.arrayContaining([
        { x: 0, z: 0, dx: 0, dz: -1, level: 1 },
        { x: 0, z: 2, dx: 0, dz: 1, level: 1 },
      ])
    );
  });

  it('行き止まり方向の隣接セルもまだ山の内部(標高≥level)なら坑口を作らない', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.S } } }],
      [toKey(0, 1), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N } } }],
    ]);
    const elevation = new Map<string, number>([
      [toKey(0, -1), 2], [toKey(0, 0), 1], [toKey(0, 1), 1],
    ]);

    const portals = elevatedTunnelPortals(railMap, elevation, 1);

    expect(portals).toEqual([{ x: 0, z: 1, dx: 0, dz: 1, level: 1 }]);
  });

  it('レベルが異なる高架は互いに独立して判定される(レベル1のみ埋まっている場合レベル2は対象外)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), {
        type: 'rail', connections: 0,
        uppers: { 1: { connections: DIR.N | DIR.S }, 2: { connections: DIR.N | DIR.S } },
      }],
    ]);
    const elevation = new Map<string, number>([[toKey(0, 0), 1]]);

    expect(elevatedTunnelPortals(railMap, elevation, 1)).toHaveLength(2);
    expect(elevatedTunnelPortals(railMap, elevation, 2)).toEqual([]);
  });
});

describe('isInElevatedTunnelInterior', () => {
  it('標高がlevel以上で、そのレベルの高架セルがあればtrueを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(3, 4), 1]]);

    expect(isInElevatedTunnelInterior(railMap, elevation, 3.2, 3.9, 1)).toBe(true);
  });

  it('標高がlevel未満なら、高架セルがあってもfalseを返す(まだ山肌より上=通常の高架)', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(3, 4), 0]]);

    expect(isInElevatedTunnelInterior(railMap, elevation, 3, 4, 1)).toBe(false);
  });

  it('level<=0(地平)は常にfalseを返す', () => {
    const railMap = new Map<string, CellData>();
    const elevation = new Map<string, number>();

    expect(isInElevatedTunnelInterior(railMap, elevation, 0, 0, 0)).toBe(false);
  });

  it('そのレベルの高架セル自体が無ければfalseを返す', () => {
    const railMap = new Map<string, CellData>([
      [toKey(3, 4), { type: 'rail', connections: 0, uppers: { 1: { connections: DIR.N | DIR.S } } }],
    ]);
    const elevation = new Map<string, number>([[toKey(3, 4), 1]]);

    expect(isInElevatedTunnelInterior(railMap, elevation, 3, 4, 2)).toBe(false);
  });
});
