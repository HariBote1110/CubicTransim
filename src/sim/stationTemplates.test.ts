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
    cells: [{ dx: 1, dz: 0, kind: 'station', axis: 'ew' }],
  };

  it('quarterTurns=0はそのまま返す', () => {
    expect(rotateTemplate(template, 0).cells).toEqual([{ dx: 1, dz: 0, kind: 'station', axis: 'ew' }]);
  });

  it('quarterTurns=1で東(1,0)は南(0,1)になる(時計回り90度)。軸もew→nsに入れ替わる', () => {
    expect(rotateTemplate(template, 1).cells).toEqual([{ dx: 0, dz: 1, kind: 'station', axis: 'ns' }]);
  });

  it('quarterTurns=2で東(1,0)は西(-1,0)になる。軸は変わらない', () => {
    expect(rotateTemplate(template, 2).cells).toEqual([{ dx: -1, dz: 0, kind: 'station', axis: 'ew' }]);
  });

  it('quarterTurns=3で東(1,0)は北(0,-1)になる。軸もew→nsに入れ替わる', () => {
    expect(rotateTemplate(template, 3).cells).toEqual([{ dx: 0, dz: -1, kind: 'station', axis: 'ns' }]);
  });

  it('crossは常にcrossのまま回転する', () => {
    const crossCell: StationTemplate = { id: 'x', name: '', description: '', cells: [{ dx: 0, dz: 0, kind: 'station', axis: 'cross' }] };
    expect(rotateTemplate(crossCell, 1).cells[0].axis).toBe('cross');
  });
});

describe('STATION_TEMPLATES', () => {
  it('crossテンプレートは中心含め9セル', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    expect(cross.cells).toHaveLength(9);
    expect(cross.cells.filter(c => c.dx === 0 && c.dz === 0)).toHaveLength(1);
    expect(cross.cells.every(c => c.kind === 'station')).toBe(true);
  });

  it('crossテンプレートは中心がcross、東西の腕がew、南北の腕がns', () => {
    const cross = STATION_TEMPLATES.find(t => t.id === 'cross')!;
    const centre = cross.cells.find(c => c.dx === 0 && c.dz === 0)!;
    expect(centre.axis).toBe('cross');
    expect(cross.cells.filter(c => c.dz === 0 && c.dx !== 0).every(c => c.axis === 'ew')).toBe(true);
    expect(cross.cells.filter(c => c.dx === 0 && c.dz !== 0).every(c => c.axis === 'ns')).toBe(true);
  });

  it('throughテンプレートは平行な長さ4の駅セル列2本(計8セル)', () => {
    const through = STATION_TEMPLATES.find(t => t.id === 'through')!;
    expect(through.cells).toHaveLength(8);
    expect(through.cells.every(c => c.kind === 'station')).toBe(true);
  });

  it('throughテンプレートはすべてewの軸を持つ', () => {
    const through = STATION_TEMPLATES.find(t => t.id === 'through')!;
    expect(through.cells.every(c => c.axis === 'ew')).toBe(true);
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

  it('throughテンプレートを90度回転すると、南北方向(ns)のconnectionsで設置される', () => {
    const through = STATION_TEMPLATES.find(t => t.id === 'through')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, through, 1, []);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.connections).toBe(DIR.N | DIR.S);
  });

  it('throughテンプレートを回転しないと、東西方向(ew)のconnectionsで設置される', () => {
    const through = STATION_TEMPLATES.find(t => t.id === 'through')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, through, 0, []);
    const cell = result.railMap.get(toKey(0, 0))!;
    expect(cell.connections).toBe(DIR.E | DIR.W);
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

describe('STATION_TEMPLATES: cross-elevated（立体交差の十字乗り換え駅）', () => {
  it('地平ホーム5セル+高架オーバーパス7セル(うち中央3セルは重複)で計11セル', () => {
    const tmpl = STATION_TEMPLATES.find(t => t.id === 'cross-elevated')!;
    // 地平(dz軸)5 + 高架(dx軸)7 - 重複(0,0)1 = 11
    const uniqueKeys = new Set(tmpl.cells.map(c => toKey(c.dx, c.dz)));
    expect(uniqueKeys.size).toBe(11);
  });

  it('高架オーバーパスの中央3セルのみlayer:1かつoverpassLine、それ以外はlayer未設定', () => {
    const tmpl = STATION_TEMPLATES.find(t => t.id === 'cross-elevated')!;
    const elevatedPlatforms = tmpl.cells.filter(c => c.layer === 1);
    expect(elevatedPlatforms).toHaveLength(3);
    expect(elevatedPlatforms.every(c => c.overpassLine && c.kind === 'station' && c.dz === 0)).toBe(true);
    expect(tmpl.cells.filter(c => !c.overpassLine).every(c => c.layer === undefined)).toBe(true);
  });

  it('設置すると、地平の十字点(0,0)が高架ホームと同じ駅IDに統合される', () => {
    const tmpl = STATION_TEMPLATES.find(t => t.id === 'cross-elevated')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, tmpl, 0, []);

    expect(result.stations.size).toBe(1);
    const st = Array.from(result.stations.values())[0];

    const centre = result.railMap.get(toKey(0, 0))!;
    expect(centre.type).toBe('station');
    expect(centre.stationId).toBe(st.id);
    expect(centre.upper?.stationId).toBe(st.id);

    // 地平ホーム(layer省略/0)と高架ホーム(layer:1)の両方がcellsに入っている
    expect(st.cells.some(c => c.x === 0 && c.z === 2 && (c.layer ?? 0) === 0)).toBe(true);
    expect(st.cells.some(c => c.x === -1 && c.z === 0 && c.layer === 1)).toBe(true);
    expect(st.cells.some(c => c.x === 1 && c.z === 0 && c.layer === 1)).toBe(true);
  });

  it('高架オーバーパスの坂・橋桁が正しく作られる(坂はramp、橋桁はupper)', () => {
    const tmpl = STATION_TEMPLATES.find(t => t.id === 'cross-elevated')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, tmpl, 0, []);

    // 坂(dx=-3,-2,2,3)
    for (const dx of [-3, -2, 2, 3]) {
      const cell = result.railMap.get(toKey(dx, 0))!;
      expect(cell.ramp).toBeDefined();
      expect(cell.upper).toBeUndefined();
    }
    // 橋桁=高架ホーム(dx=-1,0,1)
    for (const dx of [-1, 0, 1]) {
      const cell = result.railMap.get(toKey(dx, 0))!;
      expect(cell.upper?.connections).toBe(DIR.E | DIR.W);
      expect(cell.upper?.stationId).toBeDefined();
    }
  });

  it('90度回転すると高架オーバーパスが南北方向になる', () => {
    const tmpl = STATION_TEMPLATES.find(t => t.id === 'cross-elevated')!;
    const state = emptyState();
    const result = applyStationTemplate(state, { x: 0, z: 0 }, tmpl, 1, []);

    // 回転後は地平ホームが東西、高架が南北になる
    const centre = result.railMap.get(toKey(0, 0))!;
    expect(centre.connections).toBe(DIR.E | DIR.W);
    expect(centre.upper?.connections).toBe(DIR.N | DIR.S);
  });

  it('高架橋桁が車庫と重なる場合は全体を設置しない(all-or-nothing)', () => {
    const tmpl = STATION_TEMPLATES.find(t => t.id === 'cross-elevated')!;
    let state = emptyState();
    state = applyDepot(state, { x: 1, z: 0 });
    const before = state;

    const result = applyStationTemplate(state, { x: 0, z: 0 }, tmpl, 0, []);

    expect(result).toBe(before);
    expect(result.stations.size).toBe(0);
  });
});
