// S1(固定閉塞、progress/signalling-plan.md)のためのブロック索引。
//
// ブロックは「信号セルで区切られた線路の連結成分」。信号は既に方向つきで
// (pathfinding.tsが逆向きの進入を拒否する)片側からしか塞がないが、ブロックの
// 区切り自体は方向を持たない単純な無向グラフの連結成分分割にする(向きごとに
// 別のブロック割当を持たせると「対向列車がいる区間は互いに相手のブロックへは
// 入れないが自分のブロックへは入れる」のような非対称が生まれ、単線行き違いの
// 挙動が複雑になりすぎるため。信号そのものが既に方向を制約しているので、
// ブロック分割は無向で十分)。
//
// 信号セル自身はどちらのブロックにも属さない(blockKeyOfはundefinedを返す)。
// 駅・車庫はブロックを分割せず周囲のブロックへ合流する(仕様どおり)。
//
// PM4のき電索引(sim/feeding.ts)と同じ単純化として、layer!==0(高架・地下)は
// 常にundefined=S1のブロック制約の対象外とする(follow-up)。
import type { CellData } from '../types';
import { toKey, DIR } from '../utils';

export interface BlockIndex {
  /** そのセル(地平のみ)が属するブロックのキー。信号セル自身・非track・layer!==0はundefined。 */
  blockKeyOf(x: number, z: number, layer?: number): string | undefined;
}

const DIRS = [
  { x: 0, z: -1, dir: DIR.N }, { x: 1, z: -1, dir: DIR.NE },
  { x: 1, z: 0, dir: DIR.E }, { x: 1, z: 1, dir: DIR.SE },
  { x: 0, z: 1, dir: DIR.S }, { x: -1, z: 1, dir: DIR.SW },
  { x: -1, z: 0, dir: DIR.W }, { x: -1, z: -1, dir: DIR.NW },
] as const;

const oppositeOf = (dir: (typeof DIRS)[number]) => DIRS.find(d => d.x === -dir.x && d.z === -dir.z)!;

const isTrackCell = (cell: CellData | undefined): boolean => {
  if (!cell) return false;
  if (cell.signalDir) return false; // 信号セルは境界(どのブロックにも属さない)
  if (cell.type === 'rail') return (cell.connections ?? 0) !== 0;
  return cell.type === 'station' || cell.type === 'depot';
};

/**
 * railMapからブロック索引を構築する。呼び出し側(useGameLogic.ts)はrailMapが
 * 変わったときだけ再計算する(townTileIndex/feedingIndexと同じuseMemoの規律)。
 * rules.signalling!=='s1'のときも常に計算されるが、stepWorld側が参照しないため無害。
 */
export function buildBlockIndex(railMap: Map<string, CellData>): BlockIndex {
  const blockOf = new Map<string, string>();
  const visited = new Set<string>();
  let nextId = 0;

  for (const [key, cell] of railMap) {
    if (visited.has(key) || !isTrackCell(cell)) continue;
    const [sx, sz] = key.split(',').map(Number);
    const blockKey = `b${nextId++}`;
    const stack: { x: number; z: number }[] = [{ x: sx, z: sz }];
    visited.add(key);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const curKey = toKey(cur.x, cur.z);
      blockOf.set(curKey, blockKey);
      const curCell = railMap.get(curKey);
      const conns = curCell?.connections ?? 0;
      for (const d of DIRS) {
        if ((conns & d.dir) === 0) continue;
        const nx = cur.x + d.x;
        const nz = cur.z + d.z;
        const nk = toKey(nx, nz);
        if (visited.has(nk)) continue;
        const nCell = railMap.get(nk);
        if (!isTrackCell(nCell)) continue;
        // 相手セルがこちらへ戻る接続を持たなければ繋がっていない(片側配線の防御)。
        if (((nCell?.connections ?? 0) & oppositeOf(d).dir) === 0) continue;
        visited.add(nk);
        stack.push({ x: nx, z: nz });
      }
    }
  }

  return {
    blockKeyOf(x: number, z: number, layer = 0): string | undefined {
      if (layer !== 0) return undefined;
      return blockOf.get(toKey(x, z));
    },
  };
}

/**
 * segmentが触れるブロックのいずれかを、trainId以外の列車が(reservationsを通じて)
 * 保有していればtrueを返す。S1のブロック占有チェックそのもの。
 */
export function blocksOccupiedByOthers(
  reservations: Map<string, string> | undefined,
  blocks: BlockIndex,
  segment: { x: number; z: number; layer?: number }[],
  trainId: string
): boolean {
  if (!reservations || reservations.size === 0) return false;

  const targetBlocks = new Set<string>();
  for (const c of segment) {
    const bk = blocks.blockKeyOf(c.x, c.z, c.layer ?? 0);
    if (bk) targetBlocks.add(bk);
  }
  if (targetBlocks.size === 0) return false;

  for (const [key, owner] of reservations) {
    if (owner === trainId) continue;
    const parsed = parseReservationKey(key);
    if (!parsed || parsed.layer !== 0) continue;
    const bk = blocks.blockKeyOf(parsed.x, parsed.z, 0);
    if (bk && targetBlocks.has(bk)) return true;
  }
  return false;
}

const RESERVATION_KEY_RE = /^(-?\d+),(-?\d+)(?::u(\d+))?$/;

const parseReservationKey = (key: string): { x: number; z: number; layer: number } | null => {
  const m = RESERVATION_KEY_RE.exec(key);
  if (!m) return null;
  return { x: Number(m[1]), z: Number(m[2]), layer: m[3] ? Number(m[3]) : 0 };
};
