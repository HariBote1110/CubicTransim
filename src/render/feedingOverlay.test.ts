// PM4フォローアップ: き電区間の可視化オーバーレイ(buildFeedingOverlayCells)のテスト。
// progress/play-modes-plan.md PM4実装メモの続き。
import { describe, expect, it } from 'vitest';
import type { CellData } from '../types';
import { toKey, DIR } from '../utils';
import { buildFeedingIndex } from '../sim/feeding';
import { buildFeedingOverlayCells } from './feedingOverlay';

/** x方向に連続する電化(dc)複線を1本敷いたrailMapを作る。 */
const straightDcLine = (length: number): Map<string, CellData> => {
  const map = new Map<string, CellData>();
  for (let x = 0; x < length; x++) {
    let connections = 0;
    if (x > 0) connections |= DIR.W;
    if (x < length - 1) connections |= DIR.E;
    map.set(toKey(x, 0), { type: 'rail', connections, electrified: 'dc' });
  }
  return map;
};

describe('buildFeedingOverlayCells', () => {
  it('変電所に隣接する電化セルはpowered', () => {
    const railMap = straightDcLine(5);
    railMap.set(toKey(-1, 0), { type: 'substation' });
    const feeding = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    const cells = buildFeedingOverlayCells(railMap, feeding);

    const at0 = cells.find(c => c.x === 0 && c.z === 0);
    expect(at0?.colourKind).toBe('powered');
  });

  it('給電範囲外の電化セルはunpowered', () => {
    // DC_FEED_RANGE_CELLS(48)を超える長さの直線を敷き、末端が届かないことを確認する。
    const railMap = straightDcLine(60);
    railMap.set(toKey(-1, 0), { type: 'substation' });
    const feeding = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    const cells = buildFeedingOverlayCells(railMap, feeding);

    const far = cells.find(c => c.x === 59 && c.z === 0);
    expect(far?.colourKind).toBe('unpowered');
  });

  it('変電所セル自体はsubstation扱い', () => {
    const railMap = straightDcLine(3);
    railMap.set(toKey(-1, 0), { type: 'substation' });
    const feeding = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    const cells = buildFeedingOverlayCells(railMap, feeding);

    const sub = cells.find(c => c.x === -1 && c.z === 0);
    expect(sub?.colourKind).toBe('substation');
  });

  it('非電化の線路は結果に含まれない', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), { type: 'rail', connections: 0 });
    const feeding = buildFeedingIndex(railMap, []);
    const cells = buildFeedingOverlayCells(railMap, feeding);

    expect(cells.find(c => c.x === 0 && c.z === 0)).toBeUndefined();
  });

  it('容量超過区間はfeedingSectionCountsが与えられればoverload', () => {
    const railMap = straightDcLine(5);
    railMap.set(toKey(-1, 0), { type: 'substation' });
    const feeding = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    const sectionKey = feeding.sectionLoadKey(0, 0, 0)!;
    const capacity = feeding.sectionCapacity(sectionKey);
    const counts = new Map([[sectionKey, capacity + 1]]);

    const cells = buildFeedingOverlayCells(railMap, feeding, counts);
    const at0 = cells.find(c => c.x === 0 && c.z === 0);
    expect(at0?.colourKind).toBe('overload');
  });

  it('feedingSectionCounts省略時はoverload判定をしない(green/redのみ)', () => {
    const railMap = straightDcLine(5);
    railMap.set(toKey(-1, 0), { type: 'substation' });
    const feeding = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    const cells = buildFeedingOverlayCells(railMap, feeding);

    const at0 = cells.find(c => c.x === 0 && c.z === 0);
    expect(at0?.colourKind).toBe('powered');
  });
});
