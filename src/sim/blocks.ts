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
// 高架・地下(layer!==0)も、levelAdjacency.ts(pathfinding.tsと同じ隣接規則)で
// ブロックが地平をまたいで繋がる。信号(cell.signalDir)は「地平のconnectionsが無いと
// 置けない」構造物(construction.tsのapplySignal)なので常に地平にしか存在しない。
// signalDirを持つセルでも、そのセルの高架/地下レベルの線路は信号の影響を受けず
// 通しでブロックが繋がる(isTrackCellのsignalDir判定はlayer===0のときのみ有効)。
import type { CellData } from '../types';
import { toKey } from '../utils';
import { neighboursAtLayer, layerKey, activeConnections, type Layer } from './levelAdjacency';

export interface BlockIndex {
  /** そのセル・層が属するブロックのキー。信号セル自身(layer0のみ)・非trackはundefined。 */
  blockKeyOf(x: number, z: number, layer?: number): string | undefined;
}

const isTrackNode = (cell: CellData | undefined, layer: Layer): boolean => {
  if (!cell) return false;
  if (layer === 0 && cell.signalDir) return false; // 信号セル(地平限定)は境界
  if (activeConnections(cell, layer) !== 0) return true;
  if (layer !== 0) return false;
  return cell.type === 'station' || cell.type === 'depot';
};

/** cellが実際に線路(または駅・車庫、地平のみ)を持つ層の一覧。 */
const layersOf = (cell: CellData): Layer[] => {
  const layers: Layer[] = [];
  if (isTrackNode(cell, 0)) layers.push(0);
  if (cell.uppers) {
    for (const key of Object.keys(cell.uppers)) {
      const lvl = Number(key) as Layer;
      if (isTrackNode(cell, lvl)) layers.push(lvl);
    }
  }
  return layers;
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

  for (const [cellKey, cell] of railMap) {
    for (const layer of layersOf(cell)) {
      const [sx, sz] = cellKey.split(',').map(Number);
      const startKey = layerKey(sx, sz, layer);
      if (visited.has(startKey)) continue;
      const blockKey = `b${nextId++}`;
      const stack: { x: number; z: number; layer: Layer }[] = [{ x: sx, z: sz, layer }];
      visited.add(startKey);
      while (stack.length > 0) {
        const cur = stack.pop()!;
        blockOf.set(layerKey(cur.x, cur.z, cur.layer), blockKey);
        for (const n of neighboursAtLayer(railMap, cur.x, cur.z, cur.layer)) {
          const nCell = railMap.get(toKey(n.x, n.z));
          if (!isTrackNode(nCell, n.layer)) continue;
          const nKey = layerKey(n.x, n.z, n.layer);
          if (visited.has(nKey)) continue;
          visited.add(nKey);
          stack.push(n);
        }
      }
    }
  }

  return {
    blockKeyOf(x: number, z: number, layer = 0): string | undefined {
      return blockOf.get(layerKey(x, z, layer));
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
    if (!parsed) continue;
    const bk = blocks.blockKeyOf(parsed.x, parsed.z, parsed.layer);
    if (bk && targetBlocks.has(bk)) return true;
  }
  return false;
}

// PM4/S1: 高架は":uN"、地下は負のlevelなので":u-N"になる(reservation.tsのreservationKey
// と同じ規約)。旧正規表現は`\d+`のみで負の層(地下)を読み違えていた(常にNaN→layer0扱い)。
const RESERVATION_KEY_RE = /^(-?\d+),(-?\d+)(?::u(-?\d+))?$/;

const parseReservationKey = (key: string): { x: number; z: number; layer: number } | null => {
  const m = RESERVATION_KEY_RE.exec(key);
  if (!m) return null;
  return { x: Number(m[1]), z: Number(m[2]), layer: m[3] ? Number(m[3]) : 0 };
};
