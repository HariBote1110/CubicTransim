import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import { DIR, fromKey, getOppositeDir } from '../utils';
import { MATERIALS } from '../render/palette';
import {
  buildBridgeAbutmentPart, buildCellTrackParts, buildOverpassSupportParts, mergeParts,
  buildRampTrackParts, buildRampAbutmentPart, buildRampPierPart, shouldPlacePier,
  type TrackParts, type SupportParts,
} from '../render/trackGeometry';
import {
  OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL, rampHeightAtPos, rampSegmentPositions,
} from '../sim/trackPath';

// 高架のレベル1〜MAX_ELEVATED_LEVELを走査するための配列([1,2,3])。
const ELEVATED_LEVELS = Array.from({ length: MAX_ELEVATED_LEVEL }, (_, i) => (i + 1) as 1 | 2 | 3);

interface Props {
  railMap: Map<string, CellData>;
}

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

/**
 * 敷設済みの線路(バラスト・枕木・レール)をまとめて描画する。
 *
 * セルごとにmeshを作ると数百セルで数千ドローコールになるため、マテリアル単位で
 * ジオメトリをマージし、線路網全体をまとめたmeshで描く。railMapが変わるたびに
 * 作り直し、古いジオメトリはuseEffectのクリーンアップで確実に破棄する。
 *
 * 立体交差(cell.upper)を持つセルは、地平の線路(あれば)に加えて OVERPASS_HEIGHT
 * ぶん持ち上げた高架側の線路(バラスト無し)と、それを支える細い桁・間引いた橋脚を
 * 追加で描く。橋桁に隣接する橋台セル(upperを持たない側)には擁壁を1つ置く。
 */
export const TrackNetwork: React.FC<Props> = ({ railMap }) => {
  const merged = useMemo(() => {
    const all: TrackParts = { ballast: [], sleepers: [], rails: [] };
    const supports: SupportParts = { piers: [], decks: [] };
    const abutments: THREE.BufferGeometry[] = [];

    for (const [key, data] of railMap) {
      // 車庫セルは建屋を描くため線路は敷かない(建屋側で床を描く)。
      if (data.type === 'depot') continue;
      const { x, z } = fromKey(key);

      // 坂(ramp)セルは、桁側へ向かう軸ビットだけ地平の平坦な部品から除外し、
      // 代わりに斜めに登る専用パーツ(buildRampTrackParts)で描く。
      // 交差する別方向の接続(あれば)は平坦なままでよいので軸ビットだけ除く。
      const rampAxisBits = data.ramp ? (data.ramp.dir | getOppositeDir(data.ramp.dir)) : 0;
      const flatConnections = (data.connections ?? 0) & ~rampAxisBits;

      const parts = buildCellTrackParts(flatConnections, x, z);
      all.ballast.push(...parts.ballast);
      all.sleepers.push(...parts.sleepers);
      all.rails.push(...parts.rails);

      if (data.ramp) {
        // level1(base寄り)は base/level1境界→level1/level2境界、level2(base+1寄り)は
        // level1/level2境界→level2/(base+1)境界を、rampHeightAtPos(pos, base)の曲線に
        // 沿って登る。旧セーブ(levelなし)はlevel2(桁側に近い段)として扱う。
        // posLow/posHighは共有境界で地平=0・坂の中間=0.5・桁=1に一致する範囲を使う。
        // これにより地平→level1→level2→桁のどの境界でも高さの隙間が生じない。
        const level = data.ramp.level ?? 2;
        const base = data.ramp.base ?? 0;
        const [posLow, posHigh] = rampSegmentPositions(level);
        const rampParts = buildRampTrackParts(data.ramp.dir, x, z, posLow, posHigh, undefined, base);
        all.ballast.push(...rampParts.ballast);
        all.sleepers.push(...rampParts.sleepers);
        all.rails.push(...rampParts.rails);

        if (base === 0 && level === 1) {
          // 地平(base=0)に接するlevel1側だけ、従来どおり土盛りのくさびで支える。
          // 地平(pos=0)で高さ0に収束するようbuildRampAbutmentPart側のposLowは0のまま渡す。
          const wedge = buildRampAbutmentPart(data.ramp.dir, x, z, posHigh, posLow);
          if (wedge) abutments.push(wedge);
        } else {
          // それ以外(base>=1のlevel1、およびlevel2は常に)は地平に接しない
          // (空中に架かる)ので、土盛りではなく支柱で支える。
          // 従来はlevel2側にこの分岐が無く、坂の桁寄りの半分が支えの無いまま
          // 宙に浮いて見える不具合になっていた。
          const heightAtLowEnd = rampHeightAtPos(posLow, base);
          if (shouldPlacePier(x, z, data.ramp.dir)) {
            const pier = buildRampPierPart(x, z, heightAtLowEnd);
            if (pier) supports.piers.push(pier);
          }
        }
      }

      // 高架は全レベル(1〜MAX_ELEVATED_LEVEL)を走査し、レベルLの桁・レール・支柱を
      // originY = L * OVERPASS_HEIGHT で生成する。異なるレベルの桁は同一セルに併存しうる。
      for (const level of ELEVATED_LEVELS) {
        const upper = data.uppers?.[level];
        if (!upper) continue;
        const originY = level * OVERPASS_HEIGHT;

        // 高架側はバラストを敷かず、枕木とレールだけを桁の上に置く。
        const upperParts = buildCellTrackParts(upper.connections, x, z, originY, false);
        all.sleepers.push(...upperParts.sleepers);
        all.rails.push(...upperParts.rails);

        const support = buildOverpassSupportParts(upper.connections, x, z, originY);
        supports.piers.push(...support.piers);
        supports.decks.push(...support.decks);
      }

      // 橋台候補: あるレベルLの桁を持たない線路セルから見て、隣がそのレベルの桁なら
      // その方向へ擁壁を置く(地平の高さから桁下面までを埋める)。
      // ramp(坂)を持つ方向は、上のbuildRampAbutmentPart/buildRampPierPartが既に
      // 支えを置いているので、段差の直方体擁壁は重ねて描かない
      // (rampが無い旧セーブの橋台は従来どおりここで段差の擁壁を描く)。
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
      ballast: mergeParts(all.ballast),
      sleepers: mergeParts(all.sleepers),
      rails: mergeParts(all.rails),
      piers: mergeParts(supports.piers),
      decks: mergeParts(supports.decks),
      abutments: mergeParts(abutments),
    };
  }, [railMap]);

  useEffect(() => () => {
    merged.ballast?.dispose();
    merged.sleepers?.dispose();
    merged.rails?.dispose();
    merged.piers?.dispose();
    merged.decks?.dispose();
    merged.abutments?.dispose();
  }, [merged]);

  // 線路・高架桁・支柱・橋台は「クリックして選ぶ対象」ではない。react-three-fiberの
  // レイキャストを素通しにしないと、真下の地平セル(駅設置クリックなど)がヒットせず
  // 選べなくなる不具合(立体交差セルで駅が置けない)の原因になる。raycast={() => null}
  // でこれらのメッシュ自体をレイキャスト対象から外し、地面プレーンへ届かせる。
  const noRaycast = () => null;

  return (
    <group>
      {merged.decks && (
        <mesh geometry={merged.decks} material={MATERIALS.overpassDeck} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.piers && (
        <mesh geometry={merged.piers} material={MATERIALS.overpassPier} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.abutments && (
        <mesh geometry={merged.abutments} material={MATERIALS.overpassPier} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.ballast && <mesh geometry={merged.ballast} material={MATERIALS.ballast} receiveShadow raycast={noRaycast} />}
      {merged.sleepers && <mesh geometry={merged.sleepers} material={MATERIALS.sleeper} receiveShadow raycast={noRaycast} />}
      {merged.rails && (
        <mesh geometry={merged.rails} material={MATERIALS.rail as THREE.Material} castShadow raycast={noRaycast} />
      )}
    </group>
  );
};
