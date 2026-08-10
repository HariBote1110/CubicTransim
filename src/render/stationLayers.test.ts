import { describe, it, expect } from 'vitest';
import type { CellData, StationData } from '../types';
import {
  isElevatedStationCell,
  groundStationCells,
  elevatedStationCells,
  computeStationEndKeys,
  elevatedCellCandidateFromGroundClick,
  computeStationHousePlacement,
} from './stationLayers';
import { createTerrainField } from '../sim/terrainField';
import { DIR, toKey } from '../utils';

const field = createTerrainField(1, 32);
import { OVERPASS_HEIGHT } from '../sim/trackPath';

const cell = (partial: Partial<CellData>): CellData => ({
  type: 'rail',
  connections: 0,
  ...partial,
});

describe('isElevatedStationCell', () => {
  it('upperがありstationIdもあれば高架駅セル', () => {
    expect(isElevatedStationCell(cell({ uppers: { 1: { connections: 0b10001000, stationId: 's1' } } }))).toBe(true);
  });

  it('upperはあるがstationIdが無ければ単なる橋桁', () => {
    expect(isElevatedStationCell(cell({ uppers: { 1: { connections: 0b10001000 } } }))).toBe(false);
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
      uppers: { 1: { connections: 0b00100010, stationId: 'cross1' } },
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
    railMap.set(toKey(2, 2), cell({ uppers: { 1: { connections: 0b10001000 } } }));
    expect(elevatedStationCells(railMap)).toHaveLength(0);
  });

  it('レベル2/3の高架駅セルも拾い、levelフィールドに反映する', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(0, 0), cell({
      uppers: { 2: { connections: 0b10001000, stationId: 's2' } },
    }));
    railMap.set(toKey(5, 5), cell({
      uppers: { 3: { connections: 0b00100010, stationId: 's3' } },
    }));

    const elevated = elevatedStationCells(railMap);
    expect(elevated).toHaveLength(2);
    expect(elevated.find(c => c.stationId === 's2')).toMatchObject({ x: 0, z: 0, level: 2 });
    expect(elevated.find(c => c.stationId === 's3')).toMatchObject({ x: 5, z: 5, level: 3 });
  });

  it('同一セルに複数レベルの高架駅が併存していれば両方拾う', () => {
    const railMap = new Map<string, CellData>();
    railMap.set(toKey(1, 1), cell({
      uppers: {
        1: { connections: 0b10001000, stationId: 'low' },
        2: { connections: 0b00100010, stationId: 'high' },
      },
    }));
    const elevated = elevatedStationCells(railMap);
    expect(elevated).toHaveLength(2);
    expect(elevated.map(c => c.stationId).sort()).toEqual(['high', 'low']);
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

// 0.5.0-Alpha-4c: 地下にしかない駅が地上ビューで完全に消えていた(駅舎も駅名ラベルも
// 出ない)ユーザー報告への対応。駅舎は地上ビューでは出さないまま、配置自体は返して
// ラベル(GameLabels)が出せるようにする。
describe('computeStationHousePlacement: 地下のみの駅の地上ビュー表示', () => {
  const undergroundOnlyStation = (): StationData => ({
    id: 'u1',
    name: '地下駅',
    cells: [{ x: 0, z: 0, layer: -1 }],
    center: { x: 0, z: 0 },
    platformDoors: 'none',
  });
  const railMapWithUnderground = () => new Map<string, CellData>([
    [toKey(0, 0), { type: 'rail', connections: 0, uppers: { '-1': { connections: DIR.N | DIR.S, stationId: 'u1' } } } as CellData],
  ]);

  it('地上ビューでも配置(ラベルY)を返す。ただし駅舎は隠す', () => {
    const placement = computeStationHousePlacement(
      undergroundOnlyStation(), railMapWithUnderground(), field, false,
    );
    expect(placement).not.toBeNull();
    expect(placement!.houseHidden).toBe(true);
  });

  it('地下ビュー中は駅舎も出す', () => {
    const placement = computeStationHousePlacement(
      undergroundOnlyStation(), railMapWithUnderground(), field, true,
    );
    expect(placement!.houseHidden).toBe(false);
  });

  it('地平ホームを持つ駅は地上ビューでも駅舎を出す', () => {
    const station: StationData = {
      id: 's1', name: 'A駅', cells: [{ x: 0, z: 0 }], center: { x: 0, z: 0 }, platformDoors: 'none',
    };
    const railMap = new Map<string, CellData>([
      [toKey(0, 0), { type: 'station', connections: DIR.N | DIR.S, stationId: 's1' }],
    ]);
    const placement = computeStationHousePlacement(station, railMap, field, false);
    expect(placement!.houseHidden).toBe(false);
  });
});
