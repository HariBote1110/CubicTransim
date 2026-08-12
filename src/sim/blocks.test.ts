import { describe, it, expect } from 'vitest';
import { buildBlockIndex, blocksOccupiedByOthers } from './blocks';
import type { CellData } from '../types';
import { DIR, toKey } from '../utils';
import { applyRailPath, applyElevatedPath, applyUndergroundPath, type ConstructionState } from './construction';

const straight = (): Map<string, CellData> => {
  const m = new Map<string, CellData>();
  for (let x = 0; x <= 4; x++) {
    let connections = 0;
    if (x > 0) connections |= DIR.W;
    if (x < 4) connections |= DIR.E;
    m.set(toKey(x, 0), { type: 'rail', connections });
  }
  return m;
};

describe('buildBlockIndex', () => {
  it('信号が無ければ連結した線路全体が1つのブロックになる', () => {
    const railMap = straight();
    const idx = buildBlockIndex(railMap);
    const keys = new Set([0, 1, 2, 3, 4].map(x => idx.blockKeyOf(x, 0, 0)));
    expect(keys.size).toBe(1);
    expect(idx.blockKeyOf(0, 0, 0)).toBeDefined();
  });

  it('信号セルはブロックを分割し、自身はどちらのブロックにも属さない', () => {
    const railMap = straight();
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, signalDir: DIR.E });
    const idx = buildBlockIndex(railMap);
    const left = idx.blockKeyOf(0, 0, 0);
    const right = idx.blockKeyOf(4, 0, 0);
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(left).not.toBe(right);
    expect(idx.blockKeyOf(2, 0, 0)).toBeUndefined();
  });

  it('駅・車庫セルはブロックを分割しない', () => {
    const railMap = straight();
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, type: 'station', stationId: 's1' });
    const idx = buildBlockIndex(railMap);
    expect(idx.blockKeyOf(0, 0, 0)).toBe(idx.blockKeyOf(4, 0, 0));
  });

  it('地平→高架(坂)と続く区間はレベルをまたいで1つのブロックになる', () => {
    let state: ConstructionState = { railMap: new Map(), stations: new Map() };
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);

    const idx = buildBlockIndex(state.railMap);
    expect(idx.blockKeyOf(0, 0, 0)).toBeDefined();
    expect(idx.blockKeyOf(0, 0, 0)).toBe(idx.blockKeyOf(9, 0, 1));
  });

  it('地平→地下(坂)と続く区間はレベルをまたいで1つのブロックになる', () => {
    let state: ConstructionState = { railMap: new Map(), stations: new Map() };
    state = applyUndergroundPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, -1);
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);

    const idx = buildBlockIndex(state.railMap);
    expect(idx.blockKeyOf(0, 0, 0)).toBeDefined();
    expect(idx.blockKeyOf(0, 0, 0)).toBe(idx.blockKeyOf(9, 0, -1));
  });

  it('地平の信号は同じセルの高架/地下レベルのブロックを分割しない(信号は地平のみの概念)', () => {
    let state: ConstructionState = { railMap: new Map(), stations: new Map() };
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1);
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }]);
    // 地平のx=1に信号を立てる(地平のブロックだけを分割する想定)。
    const key1 = toKey(1, 0);
    state = { ...state, railMap: new Map(state.railMap).set(key1, { ...state.railMap.get(key1)!, signalDir: DIR.E }) };

    const idx = buildBlockIndex(state.railMap);
    // 高架レベル1のブロックは地平の信号に関係なく端から端まで繋がる。
    expect(idx.blockKeyOf(4, 0, 1)).toBeDefined();
    expect(idx.blockKeyOf(4, 0, 1)).toBe(idx.blockKeyOf(9, 0, 1));
  });

  it('接続していない離れた線路は別ブロックになる(connected componentsごと)', () => {
    const railMap = straight();
    railMap.set(toKey(10, 10), { type: 'rail', connections: DIR.E | DIR.W });
    const idx = buildBlockIndex(railMap);
    expect(idx.blockKeyOf(0, 0, 0)).not.toBe(idx.blockKeyOf(10, 10, 0));
  });
});

describe('blocksOccupiedByOthers', () => {
  it('他列車の予約が同じブロックに無ければfalse', () => {
    const railMap = straight();
    railMap.set(toKey(2, 0), { ...railMap.get(toKey(2, 0))!, signalDir: DIR.E });
    const idx = buildBlockIndex(railMap);
    const reservations = new Map<string, string>([[toKey(0, 0), 'trainA']]);
    const segment = [{ x: 3, z: 0 }, { x: 4, z: 0 }];
    expect(blocksOccupiedByOthers(reservations, idx, segment, 'trainB')).toBe(false);
  });

  it('他列車の予約が同じブロックにあればtrue', () => {
    const railMap = straight();
    const idx = buildBlockIndex(railMap);
    const reservations = new Map<string, string>([[toKey(3, 0), 'trainA']]);
    const segment = [{ x: 1, z: 0 }, { x: 2, z: 0 }];
    expect(blocksOccupiedByOthers(reservations, idx, segment, 'trainB')).toBe(true);
  });

  it('自分自身の予約は無視する', () => {
    const railMap = straight();
    const idx = buildBlockIndex(railMap);
    const reservations = new Map<string, string>([[toKey(3, 0), 'trainB']]);
    const segment = [{ x: 1, z: 0 }, { x: 2, z: 0 }];
    expect(blocksOccupiedByOthers(reservations, idx, segment, 'trainB')).toBe(false);
  });
});
