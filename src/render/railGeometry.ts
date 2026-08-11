// R4b: 線路網(バラスト・枕木・レール・高架桁/橋脚/橋台・掘割開口)のジオメトリ生成を
// TrackNetwork.tsx(three.js)から抽出した純粋関数。
//
// three.js側(TrackNetwork.tsx)とWebGPU側(WebGpuTrackNetwork.tsx)が同じ関数を呼ぶことで、
// 「レールをどこにどう敷くか」のロジックが二重化しない(progress/r4-threejs-retirement-plan.md
// のR4b方針: 配置ロジックは1箇所に集約する)。

import * as THREE from './geom';
import type { CellData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { DIR, fromKey, getOppositeDir } from '../utils';
import {
  buildBridgeAbutmentPart, buildCellTrackParts, buildGroundInclineTrackParts, buildOverpassSupportParts,
  mergeParts, buildRampTrackParts, buildRampAbutmentPart, buildRampPierPart, shouldPlacePier,
  buildUndergroundOpeningPart, buildCatenaryParts,
  type TrackParts, type SupportParts, type CatenaryParts,
} from './trackGeometry';
import {
  OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL, rampHeightAtPos, rampSegmentPositions,
} from '../sim/trackPath';
import { railRenderHeight } from '../sim/slopes';
import { ALL_LEVELS } from '../sim/construction';
import { undergroundBucketOf, type UndergroundBucket } from './viewMode';
import { electrificationOf } from '../sim/gameRules';

// 高架のレベル1〜MAX_ELEVATED_LEVELを走査するための配列([1,2,3])。
const ELEVATED_LEVELS = Array.from({ length: MAX_ELEVATED_LEVEL }, (_, i) => (i + 1) as 1 | 2 | 3);

const DIR_BITS = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];
const DIR_VECTORS: Record<number, { x: number; z: number }> = {
  [DIR.N]: { x: 0, z: -1 },
  [DIR.NE]: { x: 1, z: -1 },
  [DIR.E]: { x: 1, z: 0 },
  [DIR.SE]: { x: 1, z: 1 },
  [DIR.S]: { x: 0, z: 1 },
  [DIR.SW]: { x: -1, z: 1 },
  [DIR.W]: { x: -1, z: 0 },
  [DIR.NW]: { x: -1, z: -1 },
};

const emptyTrackParts = (): TrackParts => ({ ballast: [], sleepers: [], rails: [] });

export interface MergedTrackParts {
  ballast: THREE.BufferGeometry | null;
  sleepers: THREE.BufferGeometry | null;
  rails: THREE.BufferGeometry | null;
}

export interface RailNetworkGeometry {
  surface: MergedTrackParts & {
    piers: THREE.BufferGeometry | null;
    decks: THREE.BufferGeometry | null;
    abutments: THREE.BufferGeometry | null;
  };
  /** 地下ビュー中、選択中レベルに一致する地下線(通常輝度で描く)。 */
  undergroundBright: MergedTrackParts;
  /** 地下ビュー中、選択中レベル以外の地下線(暗く描く)。 */
  undergroundDim: MergedTrackParts;
  /** 地上ビュー: 地形の上へ薄く透かして重ねる地下線(全レベル合算)。 */
  undergroundGhost: MergedTrackParts;
  /** 通常表示のみ: 掘割ランプの地表開口(暗い穴+擁壁)。 */
  openings: THREE.BufferGeometry | null;
  /** electrified区間の架線(地平・高架のみ。地下は対象外)。直流(またはlegacy true)区間。 */
  catenary: { masts: THREE.BufferGeometry | null; wires: THREE.BufferGeometry | null };
  /** PM3: 交流電化区間の架線(色調のみdcと異なる。palette.tsのcatenaryMastAc/catenaryWireAc)。 */
  catenaryAc: { masts: THREE.BufferGeometry | null; wires: THREE.BufferGeometry | null };
}

/**
 * 線路網全体(敷設済みの全セル)のジオメトリをまとめて生成する。
 *
 * P8b: 地下(uppers[-1..-3]・ramp.base<0)は「surface」(地平+高架、常時表示)とは
 * 別バケットで管理する。地下ビュー中は、選択中のレベルに一致する地下だけ通常輝度
 * (bright)、それ以外の地下は暗く半透明(dim)で描く。
 *
 * 0.5.0-Alpha-4c: 地上ビューでも地下線をゴースト(undergroundGhost、地形の上へ薄く
 * 重ねる)として出すようになった。以前は地上ビューで地下を一切描かず、掘割の開口
 * だけを出していたため、地下にしかない路線・駅が地上ビューで完全に消えていた。
 * 掘割の開口(地表に開いた穴)は地上ビューでのみ従来どおり出す。
 */
export function buildRailNetworkGeometry(
  railMap: Map<string, CellData>,
  field: TerrainField,
  undergroundView: boolean,
  selectedLevel: number,
): RailNetworkGeometry {
  const surface: TrackParts = emptyTrackParts();
  const supports: SupportParts = { piers: [], decks: [] };
  const abutments: THREE.BufferGeometry[] = [];

  const undergroundBright: TrackParts = emptyTrackParts();
  const undergroundDim: TrackParts = emptyTrackParts();
  const undergroundGhost: TrackParts = emptyTrackParts();
  const openings: THREE.BufferGeometry[] = [];
  const catenary: CatenaryParts = { masts: [], wires: [] };
  const catenaryAc: CatenaryParts = { masts: [], wires: [] };

  const bucketOf = (bucket: UndergroundBucket): TrackParts =>
    bucket === 'bright' ? undergroundBright : bucket === 'dim' ? undergroundDim : undergroundGhost;

  // 地下ランプ(base<0)は base〜base+1 の1段を繋ぐので、選択レベルがどちらかの端に
  // 一致すればbright扱いにする(undergroundBucketOfへ渡す「実質のレベル」を作る)。
  const rampBucketLevel = (base: number): number =>
    selectedLevel === base + 1 ? base + 1 : base;

  for (const [key, data] of railMap) {
    // 車庫・変電所セルは建屋を描くため線路は敷かない(建屋側で床を描く)。
    if (data.type === 'depot' || data.type === 'substation') continue;
    const { x, z } = fromKey(key);

    // 坂(ramp)セルは、桁側へ向かう軸ビットだけ地平の平坦な部品から除外し、
    // 代わりに斜めに登る専用パーツ(buildRampTrackParts)で描く。
    const rampAxisBits = data.ramp ? (data.ramp.dir | getOppositeDir(data.ramp.dir)) : 0;
    const flatConnections = (data.connections ?? 0) & ~rampAxisBits;

    const renderHeight = railRenderHeight(field, data, x, z);
    if (renderHeight.kind === 'incline') {
      const inclineParts = buildGroundInclineTrackParts(
        renderHeight.dir, x, z, renderHeight.lowY, renderHeight.highY, data.gauge,
      );
      surface.ballast.push(...inclineParts.ballast);
      surface.sleepers.push(...inclineParts.sleepers);
      surface.rails.push(...inclineParts.rails);
    } else {
      const parts = buildCellTrackParts(flatConnections, x, z, renderHeight.y, true, data.gauge);
      surface.ballast.push(...parts.ballast);
      surface.sleepers.push(...parts.sleepers);
      surface.rails.push(...parts.rails);

      // 架線は地平の平坦区間だけに敷く(坂・傾斜は対象外。スコープを絞って
      // ジオメトリの増加を抑える判断。progress/play-modes-plan.md参照)。
      if (data.electrified && flatConnections !== 0) {
        const cat = buildCatenaryParts(flatConnections, x, z, renderHeight.y);
        const bucket = electrificationOf(data) === 'ac' ? catenaryAc : catenary;
        bucket.masts.push(...cat.masts);
        bucket.wires.push(...cat.wires);
      }
    }

    if (data.ramp) {
      const level = data.ramp.level ?? 2;
      const base = data.ramp.base ?? 0;
      const [posLow, posHigh] = rampSegmentPositions(level);
      const rampParts = buildRampTrackParts(data.ramp.dir, x, z, posLow, posHigh, undefined, base);

      if (base >= 0) {
        surface.ballast.push(...rampParts.ballast);
        surface.sleepers.push(...rampParts.sleepers);
        surface.rails.push(...rampParts.rails);

        if (base === 0 && level === 1) {
          const wedge = buildRampAbutmentPart(data.ramp.dir, x, z, posHigh, posLow);
          if (wedge) abutments.push(wedge);
        } else {
          const heightAtLowEnd = rampHeightAtPos(posLow, base);
          if (shouldPlacePier(x, z, data.ramp.dir)) {
            const pier = buildRampPierPart(x, z, heightAtLowEnd);
            if (pier) supports.piers.push(pier);
          }
        }
      } else {
        // 地下の坂(掘割)。地下ビューではbright/dim、地上ビューではゴーストへ入れる。
        const bucket = bucketOf(
          undergroundBucketOf(rampBucketLevel(base), undergroundView, selectedLevel),
        );
        bucket.sleepers.push(...rampParts.sleepers);
        bucket.rails.push(...rampParts.rails);
        if (base === -1) {
          bucket.ballast.push(...rampParts.ballast);
          if (!undergroundView) {
            // 地上ビューでは地表に開いた穴(暗いpit+擁壁)も従来どおり出す。
            const opening = buildUndergroundOpeningPart(data.ramp.dir, x, z);
            if (opening) openings.push(opening.pit, opening.wallA, opening.wallB);
          }
        }
      }
    }

    for (const level of ALL_LEVELS) {
      const upper = data.uppers?.[level];
      if (!upper) continue;

      const upperConnections = data.ramp && (data.ramp.base ?? 0) === level
        ? upper.connections & ~rampAxisBits
        : upper.connections;
      if (upperConnections === 0) continue;
      const originY = level * OVERPASS_HEIGHT;

      if (level > 0) {
        const upperParts = buildCellTrackParts(upperConnections, x, z, originY, false, data.gauge);
        surface.sleepers.push(...upperParts.sleepers);
        surface.rails.push(...upperParts.rails);

        const support = buildOverpassSupportParts(upperConnections, x, z, originY);
        supports.piers.push(...support.piers);
        supports.decks.push(...support.decks);

        if (data.electrified) {
          const cat = buildCatenaryParts(upperConnections, x, z, originY);
          const bucket = electrificationOf(data) === 'ac' ? catenaryAc : catenary;
          bucket.masts.push(...cat.masts);
          bucket.wires.push(...cat.wires);
        }
      } else {
        const upperParts = buildCellTrackParts(upperConnections, x, z, originY, false);
        const bucket = bucketOf(undergroundBucketOf(level, undergroundView, selectedLevel));
        bucket.sleepers.push(...upperParts.sleepers);
        bucket.rails.push(...upperParts.rails);
      }
    }

    // 橋台候補: あるレベルLの桁を持たない線路セルから見て、隣がそのレベルの桁なら
    // その方向へ擁壁を置く。
    for (const level of ELEVATED_LEVELS) {
      if (data.uppers?.[level]) continue;
      const originY = level * OVERPASS_HEIGHT;
      for (const bit of DIR_BITS) {
        if (!((data.connections ?? 0) & bit)) continue;
        if (data.ramp?.dir === bit) continue;
        const v = DIR_VECTORS[bit];
        const neighbour = railMap.get(`${x + v.x},${z + v.z}`);
        if (!neighbour?.uppers?.[level]) continue;
        if (!(neighbour.uppers[level]!.connections & getOppositeDir(bit))) continue;
        const abutment = buildBridgeAbutmentPart(bit, x, z, originY);
        if (abutment) abutments.push(abutment);
      }
    }
  }

  return {
    surface: {
      ballast: mergeParts(surface.ballast),
      sleepers: mergeParts(surface.sleepers),
      rails: mergeParts(surface.rails),
      piers: mergeParts(supports.piers),
      decks: mergeParts(supports.decks),
      abutments: mergeParts(abutments),
    },
    undergroundBright: {
      ballast: mergeParts(undergroundBright.ballast),
      sleepers: mergeParts(undergroundBright.sleepers),
      rails: mergeParts(undergroundBright.rails),
    },
    undergroundDim: {
      ballast: mergeParts(undergroundDim.ballast),
      sleepers: mergeParts(undergroundDim.sleepers),
      rails: mergeParts(undergroundDim.rails),
    },
    undergroundGhost: {
      ballast: mergeParts(undergroundGhost.ballast),
      sleepers: mergeParts(undergroundGhost.sleepers),
      rails: mergeParts(undergroundGhost.rails),
    },
    openings: mergeParts(openings),
    catenary: {
      masts: mergeParts(catenary.masts),
      wires: mergeParts(catenary.wires),
    },
    catenaryAc: {
      masts: mergeParts(catenaryAc.masts),
      wires: mergeParts(catenaryAc.wires),
    },
  };
}
