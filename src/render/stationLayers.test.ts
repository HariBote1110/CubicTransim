import { describe, it, expect } from 'vitest';
import type { CellData } from '../types';
import {
  isElevatedStationCell,
  groundStationCells,
  elevatedStationCells,
  computeStationEndKeys,
  elevatedCellCandidateFromGroundClick,
} from './stationLayers';
import { toKey } from '../utils';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

const cell = (partial: Partial<CellData>): CellData => ({
  type: 'rail',
  connections: 0,
  ...partial,
});

describe('isElevatedStationCell', () => {
  it('upperがありstationIdもあれば高架駅セル', () => {
    expect(isElevatedStationCell(cell({ upper: { connections: 0b10001000, stationId: 's1' } }))).toBe(true);
  });

  it('upperはあるがstationIdが無ければ単なる橋桁', () => {
    expect(isElevatedStationCell(cell({ upper: { connections: 0b10001000 } }))).toBe(false);
  });

  it('upperが無ければ高架駅セルではない', () => {
    expect(isElevatedStationCell(cell({}))).toBe(false);
    expect(isElevatedStationCell(undefined)).toBe(false);
  });
});

describe('groundStationCells / elevatedStationCells', () => {
  it('地平駅セルと高架駅セルを別々に集める(同じ(x,z)でも両方拾える)', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), cell({
      type: 'station', stationId: 'cross1', connections: 0b10001000,
      upper: { connections: 0b00100010, stationId: 'cross1' },
    }));
    railMap.set(toKey(0, -1), cell({ type: 'station', stationId: 'cross1', connections: 0b10001000 }));

    const ground = groundStationCells(railMap);
    const elevated = elevatedStationCells(railMap);

    expect(ground).toHaveLength(2);
    expect(elevated).toHaveLength(1);
    expect(elevated[0]).toMatchObject({ x: 0, z: 0, stationId: 'cross1', connections: 0b00100010 });
  });

  it('橋桁(stationId無し)のupperは拾わない', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(2, 2), cell({ upper: { connections: 0b10001000 } }));
    expect(elevatedStationCells(railMap)).toHaveLength(0);
  });
});

describe('computeStationEndKeys', () => {
  it('同一stationIdの8近傍が1つ以下のセルを端とみなす', () => {
    const cells = [
      { key: toKey(0, -1), x: 0, z: -1, stationId: 's', connections: 0 },
      { key: toKey(0, 0), x: 0, z: 0, stationId: 's', connections: 0 },
      { key: toKey(0, 1), x: 0, z: 1, stationId: 's', connections: 0 },
    ];
    const ends = computeStationEndKeys(cells);
    expect(ends.has(toKey(0, -1))).toBe(true);
    expect(ends.has(toKey(0, 1))).toBe(true);
    expect(ends.has(toKey(0, 0))).toBe(false);
  });

  it('stationIdが異なれば近傍としてカウントしない', () => {
    const cells = [
      { key: toKey(0, 0), x: 0, z: 0, stationId: 'a', connections: 0 },
      { key: toKey(1, 0), x: 1, z: 0, stationId: 'b', connections: 0 },
    ];
    const ends = computeStationEndKeys(cells);
    expect(ends.has(toKey(0, 0))).toBe(true);
    expect(ends.has(toKey(1, 0))).toBe(true);
  });
});

describe('elevatedCellCandidateFromGroundClick', () => {
  it('高さぶん(x+h, z+h)へ丸めた候補を返す(GameSceneのカメラ位置[20,20,20]前提)', () => {
    expect(elevatedCellCandidateFromGroundClick({ x: 3, z: -2 }, OVERPASS_HEIGHT)).toEqual({
      x: Math.round(3 + OVERPASS_HEIGHT),
      z: Math.round(-2 + OVERPASS_HEIGHT),
    });
  });

  it('高さ省略時はOVERPASS_HEIGHTを使う', () => {
    const withDefault = elevatedCellCandidateFromGroundClick({ x: 0, z: 0 });
    expect(withDefault).toEqual({ x: Math.round(OVERPASS_HEIGHT), z: Math.round(OVERPASS_HEIGHT) });
  });
});
