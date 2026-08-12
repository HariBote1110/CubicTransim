// PM4: き電インフラ(rules.electrification === 'feeding'、リアリスティック固有)。
// progress/play-modes-plan.md「3. 給電インフラ」の実装。
//
// き電区間(feeding section)は「同一電化方式(dc/ac)の電化セルが、地平・高架・地下を
// またぐ隣接(levelAdjacency.tsのneighboursAtLayer、pathfinding.tsの経路探索と同じ
// 隣接規則)で繋がった連結成分」。電化(electrified)はPM2の単純化どおりCellData本体
// (セル全体)が持つため、坂で登った先の高架・地下セルも「同じセルが持つ電化方式」を
// そのまま引き継ぐ(=坂の前後で電化方式が変わることはない)。
//
// 変電所(substation)は地平限定の構造物。「隣接(8近傍・地平)する電化セルのセクションへ
// 給電する」。給電範囲(DC/AC_FEED_RANGE_CELLS)は、変電所に隣接するセルを距離0として、
// そのセクション内を(レベルをまたいで)辿ったホップ数で数える(distance <= range のセルが
// powered。高架・地下へ登っても距離のカウントは通しで続く)。同一セクションに複数の
// 変電所が繋がっている場合、そのセクションの容量は「接続している変電所の数 ×
// SUBSTATION_CAPACITY_TRAINS」の合計になる(同じ変電所が複数の隣接セルからそのセクション
// へ繋がっていても1台としてしか数えない)。
import type { CellData, Level } from '../types';
import { toKey, DIR } from '../utils';
import { electrificationOf } from './gameRules';
import { neighboursAtLayer, layerKey, type Layer } from './levelAdjacency';

/** 直流の変電所間隔(実物どおり短い)。セル数換算。 */
export const DC_FEED_RANGE_CELLS = 48;
/** 交流の変電所間隔(実物どおり長い)。セル数換算。 */
export const AC_FEED_RANGE_CELLS = 160;
/** 変電所1棟あたりの許容在線数(電車のみ、気動車は数えない)。 */
export const SUBSTATION_CAPACITY_TRAINS = 3;
/** き電区間の在線数が容量を超えたときの牽引力係数(電圧降下の離散近似)。 */
export const OVERLOAD_ACCEL_FACTOR = 0.5;

// M3: 「区間が容量超過か」の述語をsim(simulation.ts)とrender(feedingOverlay.ts)で
// 共有する。capacity=0(変電所が1つも繋がっていない)区間に電車が残っている場合も
// 超過として扱う(count>0>capacity=0で自然に成立する。capacity>0の別ガードは不要かつ
// sim側の判定と食い違う原因だった)。
export const isOverloaded = (count: number, capacity: number): boolean => count > capacity;

interface Pos {
  x: number;
  z: number;
}

export interface FeedingIndex {
  /** そのセル(地平・高架・地下いずれも)が給電範囲内か。 */
  isPowered(x: number, z: number, level: number): boolean;
  /** そのセルが属するき電区間のキー。電化railセルでなければnull。 */
  sectionLoadKey(x: number, z: number, level: number): string | null;
  /** き電区間の容量(在線数の上限)。区間キーが未知なら0。 */
  sectionCapacity(sectionKey: string): number;
}

const DIRS = [
  { x: 0, z: -1, dir: DIR.N }, { x: 1, z: -1, dir: DIR.NE },
  { x: 1, z: 0, dir: DIR.E }, { x: 1, z: 1, dir: DIR.SE },
  { x: 0, z: 1, dir: DIR.S }, { x: -1, z: 1, dir: DIR.SW },
  { x: -1, z: 0, dir: DIR.W }, { x: -1, z: -1, dir: DIR.NW },
] as const;

const neighboursOf = (pos: Pos): Pos[] => DIRS.map(d => ({ x: pos.x + d.x, z: pos.z + d.z }));

interface Section {
  key: string;
  system: 'dc' | 'ac';
  /** layerKey(x,z,layer)の集合。地平・高架・地下の全ノードをまとめて保持する。 */
  cells: Set<string>;
}

/** cellが実際に線路を持つ層(地平connections・uppers[L].connectionsのいずれか)の一覧。 */
const layersWithTrack = (cell: CellData): Layer[] => {
  const layers: Layer[] = [];
  if (cell.connections) layers.push(0);
  if (cell.uppers) {
    for (const key of Object.keys(cell.uppers)) {
      const lvl = Number(key) as Layer;
      if (cell.uppers[lvl as Level]?.connections) layers.push(lvl);
    }
  }
  return layers;
};

/**
 * railMap/substationsからき電インフラの索引を構築する。呼び出し側(useGameLogic.ts)は
 * railMap・変電所一覧が変わったときだけ再計算する(townTileIndexと同じuseMemoの規律)。
 */
export function buildFeedingIndex(railMap: Map<string, CellData>, substations: Pos[]): FeedingIndex {
  // 1. 電化セル(PM2の単純化でCellData本体が電化方式を持つ)を洗い出す。
  const electrifiedSystem = new Map<string, 'dc' | 'ac'>();
  for (const [key, cell] of railMap) {
    if (cell.type !== 'rail' && cell.type !== 'station') continue;
    const system = electrificationOf(cell);
    if (system) electrifiedSystem.set(key, system);
  }

  // 2. 電化セルのうち実際に線路がある層ごとに「ノード」を作り、levelAdjacency.tsの
  //    neighboursAtLayer(pathfinding.tsと同じ隣接規則)で同一系統(dc/ac)の連結成分
  //    (セクション)へ分割する。坂で地平↔高架/地下を繋ぐノードは同じセルが同じ電化方式を
  //    持つため、そのまま1つのセクションに合流する。
  const cellToSection = new Map<string, Section>();
  const sections: Section[] = [];
  const visited = new Set<string>();

  for (const [cellKey, cell] of railMap) {
    const system = electrifiedSystem.get(cellKey);
    if (!system) continue;
    for (const layer of layersWithTrack(cell)) {
      const [sx, sz] = cellKey.split(',').map(Number);
      const startKey = layerKey(sx, sz, layer);
      if (visited.has(startKey)) continue;

      const cells = new Set<string>();
      const queue: { x: number; z: number; layer: Layer }[] = [{ x: sx, z: sz, layer }];
      visited.add(startKey);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        cells.add(layerKey(cur.x, cur.z, cur.layer));
        for (const n of neighboursAtLayer(railMap, cur.x, cur.z, cur.layer)) {
          const nCellKey = toKey(n.x, n.z);
          if (electrifiedSystem.get(nCellKey) !== system) continue;
          const nKey = layerKey(n.x, n.z, n.layer);
          if (visited.has(nKey)) continue;
          visited.add(nKey);
          queue.push(n);
        }
      }
      const section: Section = { key: startKey, system, cells };
      sections.push(section);
      for (const k of cells) cellToSection.set(k, section);
    }
  }

  // 3. 変電所(地平限定)ごとに、隣接(地平8近傍)する各セクションへ多始点BFSで給電範囲を
  //    広げる。ホップ数はレベルをまたいでも通しで数える(坂を上っても距離のカウントは
  //    続く)。同じ変電所が同一セクションへ複数の隣接セルから繋がっていても容量は
  //    1台ぶんのみ数える。
  const poweredCells = new Set<string>();
  const sectionSubstationCount = new Map<string, number>();

  for (const sub of substations) {
    const touchedSections = new Map<Section, string[]>();
    for (const n of neighboursOf(sub)) {
      const nKey = layerKey(n.x, n.z, 0);
      const section = cellToSection.get(nKey);
      if (!section) continue;
      const starts = touchedSections.get(section) ?? [];
      starts.push(nKey);
      touchedSections.set(section, starts);
    }

    for (const [section, starts] of touchedSections) {
      sectionSubstationCount.set(section.key, (sectionSubstationCount.get(section.key) ?? 0) + 1);
      const range = section.system === 'ac' ? AC_FEED_RANGE_CELLS : DC_FEED_RANGE_CELLS;

      const localVisited = new Set(starts);
      const queue: { key: string; x: number; z: number; layer: Layer; d: number }[] = starts.map(k => {
        const [x, z] = k.split(':')[0].split(',').map(Number);
        return { key: k, x, z, layer: 0, d: 0 };
      });
      for (const s of starts) poweredCells.add(s);

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.d >= range) continue;
        for (const n of neighboursAtLayer(railMap, cur.x, cur.z, cur.layer)) {
          const nKey = layerKey(n.x, n.z, n.layer);
          if (!section.cells.has(nKey)) continue;
          if (localVisited.has(nKey)) continue;
          localVisited.add(nKey);
          poweredCells.add(nKey);
          queue.push({ key: nKey, x: n.x, z: n.z, layer: n.layer, d: cur.d + 1 });
        }
      }
    }
  }

  const sectionCapacity = new Map<string, number>();
  for (const section of sections) {
    sectionCapacity.set(section.key, (sectionSubstationCount.get(section.key) ?? 0) * SUBSTATION_CAPACITY_TRAINS);
  }

  return {
    isPowered(x, z, level) {
      return poweredCells.has(layerKey(x, z, level));
    },
    sectionLoadKey(x, z, level) {
      return cellToSection.get(layerKey(x, z, level))?.key ?? null;
    },
    sectionCapacity(sectionKey) {
      return sectionCapacity.get(sectionKey) ?? 0;
    },
  };
}
