import { describe, expect, it } from 'vitest';
import { DIR, toKey } from '../utils';
import type { CellData, StationData } from '../types';
import {
  applyRailPath,
  applyStation,
  applyDepot,
  applySignal,
  removePath,
  type ConstructionState,
} from './construction';

const emptyState = (): ConstructionState => ({
  railMap: new Map<string, CellData>(),
  stations: new Map<string, StationData>(),
});

describe('applyRailPath（特性テスト）', () => {
  it('直線区間で双方向の connections が張られる', () => {
    const state = emptyState();
    const result = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);

    const a = result.railMap.get(toKey(0, 0))!;
    const b = result.railMap.get(toKey(1, 0))!;
    expect(a.type).toBe('rail');
    expect(a.connections! & DIR.E).toBe(DIR.E);
    expect(b.connections! & DIR.W).toBe(DIR.W);
  });

  it('元の state を変更しない（immutable）', () => {
    const state = emptyState();
    applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    expect(state.railMap.size).toBe(0);
  });
});

describe('applyStation（特性テスト）', () => {
  it('空セルに駅を設置すると新しい駅IDと N|E|S|W の connections を持つ', () => {
    const state = emptyState();
    const result = applyStation(state, { x: 0, z: 0 });
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('station');
    expect(cell.connections).toBe(DIR.N | DIR.E | DIR.S | DIR.W);
    expect(result.stations.size).toBe(1);
  });

  it('隣接する駅セルに設置すると同じ駅IDにマージされる', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    const firstId = Array.from(state.stations.keys())[0];
    state = applyStation(state, { x: 1, z: 0 });

    expect(state.stations.size).toBe(1);
    const st = state.stations.get(firstId)!;
    expect(st.cells).toHaveLength(2);
    expect(st.center).toEqual({ x: 0.5, z: 0 });
  });
});

describe('applyDepot（特性テスト）', () => {
  it('空セルには車庫を設置できる', () => {
    const state = emptyState();
    const result = applyDepot(state, { x: 0, z: 0 });
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.type).toBe('depot');
  });
});

describe('applySignal（特性テスト）', () => {
  it('rail セルに最初のシグナルを設置すると connections の最初の方向になる', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const result = applySignal(state, [{ x: 0, z: 0 }]);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.signalDir).toBe(DIR.E);
  });
});

describe('removePath（特性テスト）', () => {
  it('rail を削除すると隣接セルの connections も掃除される', () => {
    let state = emptyState();
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    const result = removePath(state, [{ x: 0, z: 0 }]);

    expect(result.railMap.has(toKey(0, 0))).toBe(false);
    const neighbour = result.railMap.get(toKey(1, 0))!;
    expect(neighbour.connections! & DIR.W).toBe(0);
  });

  it('駅セルを削除すると駅データからも該当セルが除去される（全セル削除で駅ごと消える）', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    const result = removePath(state, [{ x: 0, z: 0 }]);

    expect(result.railMap.has(toKey(0, 0))).toBe(false);
    expect(result.stations.size).toBe(0);
  });

  it('駅の一部セルだけ削除すると駅は残り center が再計算される', () => {
    let state = emptyState();
    state = applyStation(state, { x: 0, z: 0 });
    state = applyStation(state, { x: 1, z: 0 });
    const stationId = Array.from(state.stations.keys())[0];

    const result = removePath(state, [{ x: 1, z: 0 }]);

    const st = result.stations.get(stationId)!;
    expect(st.cells).toHaveLength(1);
    expect(st.center).toEqual({ x: 0, z: 0 });
  });
});
