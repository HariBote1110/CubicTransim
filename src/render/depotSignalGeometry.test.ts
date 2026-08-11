import { describe, it, expect } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData } from '../types';
import { createTerrainField } from '../sim/terrainField';
import { buildDepotGeometries } from './depotGeometry';
import { buildSignalGeometries } from './signalGeometry';
import { buildTunnelPortalGeometries } from './tunnelPortalMeshGeometry';
import { buildWaterBridgeGeometries } from './waterBridgeGeometry';
import { tunnelPortals } from '../sim/tunnel';

describe('buildDepotGeometries', () => {
  it('9パーツ(床・線路2・側壁2・奥壁・垂れ壁・開口・屋根)を生成する', () => {
    const entries = buildDepotGeometries([0, 0, 0], 0);
    expect(entries).toHaveLength(9);
    expect(entries.every(e => !e.translucent)).toBe(true);
  });
});

describe('buildSignalGeometries', () => {
  it('7パーツを生成し、地面マーカーだけtranslucent', () => {
    const entries = buildSignalGeometries([0, 0, 0], DIR.N);
    expect(entries).toHaveLength(7);
    expect(entries.filter(e => e.translucent)).toHaveLength(1);
  });
});

describe('buildWaterBridgeGeometries', () => {
  it('data.bridgeのセル1つにつき桁1+橋脚2の3パーツを生成する', () => {
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, bridge: true }],
      [toKey(1, 0), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const entries = buildWaterBridgeGeometries(railMap);
    expect(entries).toHaveLength(3);
  });
});

describe('buildTunnelPortalGeometries', () => {
  it('坑口1つにつきヘッドウォール・笠石・暗がり・ボディ・翼壁2枚の6パーツを生成する', () => {
    const field = createTerrainField(1, 32);
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'rail', connections: DIR.N | DIR.S, tunnel: { height: 0 } }],
      [toKey(0, 1), { type: 'rail', connections: DIR.N | DIR.S }],
    ]);
    const portals = tunnelPortals(railMap, field);
    expect(portals.length).toBeGreaterThan(0);
    const entries = buildTunnelPortalGeometries(portals, field);
    expect(entries).toHaveLength(portals.length * 6);
  });
});
