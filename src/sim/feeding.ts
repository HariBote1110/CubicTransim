// PM4: き電インフラ(rules.electrification === 'feeding'、リアリスティック固有)。
// progress/play-modes-plan.md「3. 給電インフラ」の実装。
//
// き電区間(feeding section)は「同一電化方式(dc/ac)の電化railセルが接続で繋がった
// 連結成分」。BFSは地平(level 0)のconnectionsだけを辿る(高架・地下のき電は
// スコープ外の単純化。isPowered/sectionLoadKeyはlevel!==0なら常に「給電あり・
// セクション無し」を返す。follow-upとしてPM4実装メモに明記する)。
//
// 変電所(substation)は「隣接(8近傍)する電化railセルのセクションへ給電する」。
// 給電範囲(DC/AC_FEED_RANGE_CELLS)は、変電所に隣接するセルを距離0として、
// そのセクション内をconnectionsで辿ったホップ数で数える(distance <= range のセルが
// powered)。同一セクションに複数の変電所が繋がっている場合、そのセクションの容量は
// 「接続している変電所の数 × SUBSTATION_CAPACITY_TRAINS」の合計になる
// (同じ変電所が複数の隣接セルからそのセクションへ繋がっていても1台としてしか数えない)。
import type { CellData } from '../types';
import { toKey, DIR } from '../utils';
import { electrificationOf } from './gameRules';

/** 直流の変電所間隔(実物どおり短い)。セル数換算。 */
export const DC_FEED_RANGE_CELLS = 48;
/** 交流の変電所間隔(実物どおり長い)。セル数換算。 */
export const AC_FEED_RANGE_CELLS = 160;
/** 変電所1棟あたりの許容在線数(電車のみ、気動車は数えない)。 */
export const SUBSTATION_CAPACITY_TRAINS = 3;
/** き電区間の在線数が容量を超えたときの牽引力係数(電圧降下の離散近似)。 */
export const OVERLOAD_ACCEL_FACTOR = 0.5;

interface Pos {
  x: number;
  z: number;
}

export interface FeedingIndex {
  /** そのセル(地平)が給電範囲内か。level!==0なら常にtrue(スコープ外の単純化)。 */
  isPowered(x: number, z: number, level: number): boolean;
  /** そのセルが属するき電区間のキー。電化railセルでなければnull。level!==0なら常にnull。 */
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
  cells: Set<string>;
}

/**
 * railMap/substationsからき電インフラの索引を構築する。呼び出し側(useGameLogic.ts)は
 * railMap・変電所一覧が変わったときだけ再計算する(townTileIndexと同じuseMemoの規律)。
 */
export function buildFeedingIndex(railMap: Map<string, CellData>, substations: Pos[]): FeedingIndex {
  // 1. 電化railセルを同一系統(dc/ac)の連結成分(セクション)へ分割する。
  const electrifiedSystem = new Map<string, 'dc' | 'ac'>();
  for (const [key, cell] of railMap) {
    if (cell.type !== 'rail' && cell.type !== 'station') continue;
    const system = electrificationOf(cell);
    if (system) electrifiedSystem.set(key, system);
  }

  const cellToSection = new Map<string, Section>();
  const sections: Section[] = [];
  const visited = new Set<string>();

  for (const startKey of electrifiedSystem.keys()) {
    if (visited.has(startKey)) continue;
    const system = electrifiedSystem.get(startKey)!;
    const cells = new Set<string>();
    const [sx, sz] = startKey.split(',').map(Number);
    const queue: Pos[] = [{ x: sx, z: sz }];
    visited.add(startKey);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curKey = toKey(cur.x, cur.z);
      cells.add(curKey);
      const connections = railMap.get(curKey)?.connections ?? 0;
      for (const d of DIRS) {
        if ((connections & d.dir) === 0) continue;
        const nKey = toKey(cur.x + d.x, cur.z + d.z);
        if (visited.has(nKey)) continue;
        if (electrifiedSystem.get(nKey) !== system) continue;
        visited.add(nKey);
        queue.push({ x: cur.x + d.x, z: cur.z + d.z });
      }
    }
    const section: Section = { key: startKey, system, cells };
    sections.push(section);
    for (const k of cells) cellToSection.set(k, section);
  }

  // 2. 変電所ごとに、隣接する各セクションへ多始点BFSで給電範囲を広げる。
  //    同じ変電所が同一セクションへ複数の隣接セルから繋がっていても容量は1台ぶんのみ数える。
  const poweredCells = new Set<string>();
  const sectionSubstationCount = new Map<string, number>();

  for (const sub of substations) {
    const touchedSections = new Map<Section, string[]>();
    for (const n of neighboursOf(sub)) {
      const nKey = toKey(n.x, n.z);
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
      const queue: { key: string; x: number; z: number; d: number }[] = starts.map(k => {
        const [x, z] = k.split(',').map(Number);
        return { key: k, x, z, d: 0 };
      });
      for (const s of starts) poweredCells.add(s);

      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur.d >= range) continue;
        const connections = railMap.get(cur.key)?.connections ?? 0;
        for (const d of DIRS) {
          if ((connections & d.dir) === 0) continue;
          const nx = cur.x + d.x;
          const nz = cur.z + d.z;
          const nKey = toKey(nx, nz);
          if (!section.cells.has(nKey)) continue;
          if (localVisited.has(nKey)) continue;
          localVisited.add(nKey);
          poweredCells.add(nKey);
          queue.push({ key: nKey, x: nx, z: nz, d: cur.d + 1 });
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
      if (level !== 0) return true;
      return poweredCells.has(toKey(x, z));
    },
    sectionLoadKey(x, z, level) {
      if (level !== 0) return null;
      return cellToSection.get(toKey(x, z))?.key ?? null;
    },
    sectionCapacity(sectionKey) {
      return sectionCapacity.get(sectionKey) ?? 0;
    },
  };
}
