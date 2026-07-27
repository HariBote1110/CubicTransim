import { describe, expect, it } from 'vitest';
import { toKey, DIR } from '../utils';
import type { CellData, StationData, TerrainType } from '../types';
import { applyDepot, type ConstructionState } from './construction';
import {
  STATION_TEMPLATES,
  rotateTemplate,
  applyStationTemplate,
  type StationTemplate,
} from './stationTemplates';

const emptyState = (): ConstructionState => ({
  railMap: new Map<string, CellData>(),
  stations: new Map<string, StationData>(),
});

describe('rotateTemplate', () => {
  const template: StationTemplate = {
    id: 't',
    name: 'テスト',
    description: '',
    cells: [{ dx: 1, dz: 0, kind: 'station' }],
  };

  it('quarterTurns=0はそのまま返す', () => {
    expect(rotateTemplate(template, 0).cells).toEqual([{ dx: 1, dz: 0, kind: 'station' }]);
  });

  it('quarterTurns=1で東(1,0)は南(0,1)になる(時計回り90度)', () => {
    expect(rotateTemplate(template, 1).cells).toEqual([{ dx: 0, dz: 1, kind: 'station' }]);
  });

  it('quarterTurns=2で東(1,0)は西(-1,0)になる', () => {
    expect(rotateTemplate(template, 2).cells).toEqual([{ dx: -1, dz: 0, kind: 'station' }]);
  });

  it('quarterTurns=3で東(1,0)は北(0,-1)になる', () => {
    expect(rotateTemplate(template, 3).cells).toEqual([{ dx: 0, dz: -1, kind: 'station' }]);
  });
});

describe('STATION_TEMPLATES', () => {
  it('crossテンプレートは中心含め9セル', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    expect(cross.cells).toHaveLength(9);
    expect(cross.cells.filter(c => c.dx === 0 && c.dz === 0)).toHaveLength(1);
    expect(cross.cells.every(c => c.kind === 'station')).toBe(true);
  });

  it('throughテンプレートは平行な長さ4の駅セル列2本(計8セル)', () => {
    const through = STATION_TEMPLATES.find(t => t.id === 'through')!;
    expect(through.cells).toHaveLength(8);
    expect(through.cells.every(c => c.kind === 'station')).toBe(true);
  });
});

describe('applyStationTemplate', () => {
  it('crossテンプレートを設置すると9セルが1つの駅に統合される', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, cross, 0, []);

    expect(result.stations.size).toBe(1);
    const st = Array.from(result.stations.values())[0];
    expect(st.cells).toHaveLength(9);

    const centreCell = result.railMap.get(toKey(0, 0))!;
    expect(centreCell.type).toBe('station');
    expect(centreCell.connections).toBe(DIR.N | DIR.E | DIR.S | DIR.W);

    // 南北・東西の両腕が同じ駅IDに属する
    expect(result.railMap.get(toKey(0, -2))!.stationId).toBe(st.id);
    expect(result.railMap.get(toKey(2, 0))!.stationId).toBe(st.id);
  });

  it('throughテンプレートを設置すると隣接する2本の駅列が1つの駅に統合される', () => {
    const through = STATION_TEMPLATES.find(t => t.id === 'through')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, through, 0, []);

    expect(result.stations.size).toBe(1);
    const st = Array.from(result.stations.values())[0];
    expect(st.cells).toHaveLength(8);
  });

  it('quarterTurnsを指定すると回転して設置される', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    const state = emptyState();
    // crossは回転対称なので、90度回転しても占有セル集合は変わらないはず
    const result = applyStationTemplate(state, { x: 0, z: 0 }, cross, 1, []);
    expect(result.railMap.get(toKey(0, -2))).toBeDefined();
    expect(result.railMap.get(toKey(2, 0))).toBeDefined();
  });

  it('一部のセルが車庫と重なる場合は全体を設置しない(all-or-nothing)', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    let state = emptyState();
    // テンプレートの腕の1セルを車庫で塞いでおく
    state = applyDepot(state, { x: 2, z: 0 });

    const before = state;
    const result = applyStationTemplate(state, { x: 0, z: 0 }, cross, 0, []);

    expect(result).toBe(before);
    expect(result.stations.size).toBe(0);
    expect(result.railMap.size).toBe(1); // 車庫のみ残る
  });

  it('一部のセルが水域で設置不可の場合は全体を設置しない(all-or-nothing)', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    const state = emptyState();
    const terrain = new Map<string, TerrainType>([[toKey(0, -2), 'water']]);

    const result = applyStationTemplate(state, { x: 0, z: 0 }, cross, 0, [], terrain);

    expect(result).toBe(state);
    expect(result.railMap.size).toBe(0);
  });
});
