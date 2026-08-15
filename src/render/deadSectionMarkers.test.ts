import { describe, it, expect } from 'vitest';
import type { CellData } from '../types';
import { DIR } from '../utils';
import { findDeadSectionMarkerEdges } from './deadSectionMarkers';

describe('deadSectionMarkers: findDeadSectionMarkerEdges (PM3 デッドセクション標識の設置位置)', () => {
  it('dc/acが実際に線路で繋がっている境界に1件だけマーカーを置く(逆向きの二重計上をしない)', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: DIR.E, electrified: 'dc' }],
      ['1,0', { type: 'rail', connections: DIR.W, electrified: 'ac' }],
    ]);
    const edges = findDeadSectionMarkerEdges(railMap);
    expect(edges).toEqual([{ x: 0, z: 0, dir: DIR.E }]);
  });

  it('同一電化方式(dc/dc)の隣接セルにはマーカーを置かない', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: DIR.E, electrified: 'dc' }],
      ['1,0', { type: 'rail', connections: DIR.W, electrified: 'dc' }],
    ]);
    expect(findDeadSectionMarkerEdges(railMap)).toEqual([]);
  });

  it('電化方式が異なっていても線路として繋がっていなければマーカーを置かない(隣接しているだけでconnectionsが無い)', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: 0, electrified: 'dc' }],
      ['1,0', { type: 'rail', connections: 0, electrified: 'ac' }],
    ]);
    expect(findDeadSectionMarkerEdges(railMap)).toEqual([]);
  });

  it('片方が非電化ならマーカーを置かない(デッドセクションではない)', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: DIR.E, electrified: 'dc' }],
      ['1,0', { type: 'rail', connections: DIR.W }],
    ]);
    expect(findDeadSectionMarkerEdges(railMap)).toEqual([]);
  });

  it('斜め方向(SE)の境界も検出できる', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: DIR.SE, electrified: 'dc' }],
      ['1,1', { type: 'rail', connections: DIR.NW, electrified: 'ac' }],
    ]);
    expect(findDeadSectionMarkerEdges(railMap)).toEqual([{ x: 0, z: 0, dir: DIR.SE }]);
  });

  it('北(N)側の境界は隣接セルから見た南(S)方向として1件で検出される(重複計上しない正準化の確認)', () => {
    const railMap = new Map<string, CellData>([
      ['0,0', { type: 'rail', connections: DIR.N, electrified: 'ac' }],
      ['0,-1', { type: 'rail', connections: DIR.S, electrified: 'dc' }],
    ]);
    expect(findDeadSectionMarkerEdges(railMap)).toEqual([{ x: 0, z: -1, dir: DIR.S }]);
  });
});
