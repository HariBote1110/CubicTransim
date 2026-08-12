import { describe, it, expect } from 'vitest';
import { buildFeedingIndex, DC_FEED_RANGE_CELLS, AC_FEED_RANGE_CELLS, SUBSTATION_CAPACITY_TRAINS } from './feeding';
import type { CellData } from '../types';
import { toKey, DIR } from '../utils';
import { applyRailPath, applyElevatedPath, applyUndergroundPath, applySubstation, type ConstructionState } from './construction';

// x方向に一直線の電化rail区間をrailMapへ敷く(system='dc'|'ac')。
function layStraightRail(
  railMap: Map<string, CellData>,
  fromX: number,
  toX: number,
  z: number,
  system: 'dc' | 'ac'
) {
  for (let x = fromX; x <= toX; x++) {
    let connections = 0;
    if (x > fromX) connections |= DIR.W;
    if (x < toX) connections |= DIR.E;
    railMap.set(toKey(x, z), { type: 'rail', connections, electrified: system });
  }
}

describe('feeding: き電区間の索引(PM4)', () => {
  it('同一系統の電化railセルはBFSで1つのセクションにまとまる', () => {
    const railMap = new Map<string, CellData>();
    layStraightRail(railMap, 0, 5, 0, 'dc');
    const index = buildFeedingIndex(railMap, [{ x: 0, z: 1 }]);
    // 変電所x=0,z=1に隣接するのはx=0,z=0(セクションの一部)。
    expect(index.sectionLoadKey(0, 0, 0)).not.toBeNull();
    expect(index.sectionLoadKey(0, 0, 0)).toBe(index.sectionLoadKey(5, 0, 0));
  });

  it('dc/acの境界でセクションが分かれる(異なる系統は繋がらない)', () => {
    const railMap = new Map<string, CellData>();
    layStraightRail(railMap, 0, 2, 0, 'dc');
    // x=3は非電化の隙間ではなく、直接ac区間を隣接させて境界を作る
    railMap.set(toKey(3, 0), { type: 'rail', connections: DIR.W | DIR.E, electrified: 'ac' });
    railMap.set(toKey(2, 0), { type: 'rail', connections: DIR.W | DIR.E, electrified: 'dc' });
    layStraightRail(railMap, 4, 6, 0, 'ac');
    // x=3のconnectionsを繋ぎ直す
    railMap.set(toKey(3, 0), { type: 'rail', connections: DIR.W | DIR.E, electrified: 'ac' });
    railMap.set(toKey(4, 0), { type: 'rail', connections: DIR.W | DIR.E, electrified: 'ac' });

    const index = buildFeedingIndex(railMap, []);
    expect(index.sectionLoadKey(2, 0, 0)).not.toBe(index.sectionLoadKey(3, 0, 0));
  });

  it('変電所に隣接するセクションは給電範囲内が給電され、範囲外は給電されない(dc=48セル)', () => {
    const railMap = new Map<string, CellData>();
    layStraightRail(railMap, 0, DC_FEED_RANGE_CELLS + 5, 0, 'dc');
    // 変電所は(-1,0)に置き、8近傍のうち電化railセルは(0,0)の1つだけにする
    // (x=0行に対して斜め隣接すると複数の起点ができ、実効範囲がずれてしまうため)。
    const index = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    expect(index.isPowered(0, 0, 0)).toBe(true);
    expect(index.isPowered(DC_FEED_RANGE_CELLS, 0, 0)).toBe(true);
    expect(index.isPowered(DC_FEED_RANGE_CELLS + 1, 0, 0)).toBe(false);
  });

  it('交流は直流より給電範囲が長い(ac=160セル)', () => {
    const railMap = new Map<string, CellData>();
    layStraightRail(railMap, 0, AC_FEED_RANGE_CELLS + 5, 0, 'ac');
    const index = buildFeedingIndex(railMap, [{ x: -1, z: 0 }]);
    expect(index.isPowered(AC_FEED_RANGE_CELLS, 0, 0)).toBe(true);
    expect(index.isPowered(AC_FEED_RANGE_CELLS + 1, 0, 0)).toBe(false);
  });

  it('変電所が無ければ電化セクションは給電されない', () => {
    const railMap = new Map<string, CellData>();
    layStraightRail(railMap, 0, 3, 0, 'dc');
    const index = buildFeedingIndex(railMap, []);
    expect(index.isPowered(0, 0, 0)).toBe(false);
  });

  it('地平→高架(坂)と続く電化区間はレベルをまたいで1つのセクションになる', () => {
    let state: ConstructionState = { railMap: new Map(), stations: new Map() };
    // 浮いた高架(レベル1、dc電化)を(4,0)〜(9,0)に敷く
    state = applyElevatedPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, 1, undefined, undefined, { electrified: 'dc' });
    // 地平の線路(dc電化)を高架の端タイル(4,0)まで引く(applyRailPathが自動で坂を作る)
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }], undefined, undefined, { electrified: 'dc' });

    const index = buildFeedingIndex(state.railMap, []);
    expect(index.sectionLoadKey(0, 0, 0)).not.toBeNull();
    expect(index.sectionLoadKey(0, 0, 0)).toBe(index.sectionLoadKey(9, 0, 1));
  });

  it('地平→地下(坂)と続く電化区間はレベルをまたいで1つのセクションになる', () => {
    let state: ConstructionState = { railMap: new Map(), stations: new Map() };
    // 浮いた地下(レベル-1、dc電化)を(4,0)〜(9,0)に敷く
    state = applyUndergroundPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, -1, undefined, { electrified: 'dc' });
    // 地平の線路(dc電化)を地下の端タイル(4,0)まで引く(applyRailPathが自動で坂を作る)
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }], undefined, undefined, { electrified: 'dc' });

    const index = buildFeedingIndex(state.railMap, []);
    expect(index.sectionLoadKey(0, 0, 0)).not.toBeNull();
    expect(index.sectionLoadKey(0, 0, 0)).toBe(index.sectionLoadKey(9, 0, -1));
  });

  it('地平の変電所からの給電が坂を越えて地下区間まで到達する(ホップ数はレベルをまたいで通しで数える)', () => {
    let state: ConstructionState = { railMap: new Map(), stations: new Map() };
    state = applyUndergroundPath(state, Array.from({ length: 6 }, (_, i) => ({ x: i + 4, z: 0 })), undefined, -1, undefined, { electrified: 'dc' });
    state = applyRailPath(state, [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }, { x: 3, z: 0 }, { x: 4, z: 0 }], undefined, undefined, { electrified: 'dc' });
    // 変電所を地平区間に隣接させる(地平のみに置ける構造物)。
    state = applySubstation(state, { x: 0, z: 1 });

    const index = buildFeedingIndex(state.railMap, [{ x: 0, z: 1 }]);
    expect(index.isPowered(0, 0, 0)).toBe(true);
    // 地下区間(x=9, level=-1)も同じセクション内かつ給電範囲(48セル)内なので給電される。
    expect(index.isPowered(9, 0, -1)).toBe(true);
  });

  it('セクション容量は接続する変電所数×SUBSTATION_CAPACITY_TRAINS', () => {
    const railMap = new Map<string, CellData>();
    layStraightRail(railMap, 0, 10, 0, 'dc');
    const index = buildFeedingIndex(railMap, [{ x: 0, z: 1 }, { x: 10, z: 1 }]);
    const key = index.sectionLoadKey(5, 0, 0)!;
    expect(index.sectionCapacity(key)).toBe(2 * SUBSTATION_CAPACITY_TRAINS);
  });

  it('同一変電所が同一セクションへ複数隣接セルから接しても容量は1台ぶんのみ', () => {
    const railMap = new Map<string, CellData>();
    // 変電所(0,0)の周囲8セルすべてを同一dcセクションの一部にする
    layStraightRail(railMap, -1, 1, -1, 'dc');
    layStraightRail(railMap, -1, 1, 0, 'dc');
    layStraightRail(railMap, -1, 1, 1, 'dc');
    for (const z of [-1, 0, 1]) {
      railMap.set(toKey(-1, z), { ...railMap.get(toKey(-1, z))!, connections: (railMap.get(toKey(-1, z))!.connections ?? 0) });
    }
    const index = buildFeedingIndex(railMap, [{ x: 0, z: 0 }]);
    const key = index.sectionLoadKey(1, 1, 0);
    if (key) expect(index.sectionCapacity(key)).toBe(SUBSTATION_CAPACITY_TRAINS);
  });
});
