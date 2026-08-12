import { describe, it, expect } from 'vitest';
import { buildBlockIndex, blocksOccupiedByOthers } from './blocks';
import type { CellData } from '../types';
import { DIR, toKey } from '../utils';

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

  it('layerが0以外なら常にundefined(S1の対象外)', () => {
    const railMap = straight();
    const idx = buildBlockIndex(railMap);
    expect(idx.blockKeyOf(0, 0, 1)).toBeUndefined();
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
