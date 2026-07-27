import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import { DIR, fromKey, getOppositeDir } from '../utils';
import { MATERIALS } from '../render/palette';
import {
  buildBridgeAbutmentPart, buildCellTrackParts, buildOverpassSupportParts, mergeParts,
  buildRampTrackParts, buildRampAbutmentPart,
  type TrackParts, type SupportParts,
} from '../render/trackGeometry';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

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
        const rampParts = buildRampTrackParts(data.ramp.dir, x, z, OVERPASS_HEIGHT);
        all.ballast.push(...rampParts.ballast);
        all.sleepers.push(...rampParts.sleepers);
        all.rails.push(...rampParts.rails);

        const wedge = buildRampAbutmentPart(data.ramp.dir, x, z, OVERPASS_HEIGHT);
        if (wedge) abutments.push(wedge);
      }

      if (data.upper) {
        // 高架側はバラストを敷かず、枕木とレールだけを桁の上に置く。
        const upperParts = buildCellTrackParts(data.upper.connections, x, z, OVERPASS_HEIGHT, false);
        all.sleepers.push(...upperParts.sleepers);
        all.rails.push(...upperParts.rails);

        const support = buildOverpassSupportParts(data.upper.connections, x, z, OVERPASS_HEIGHT);
        supports.piers.push(...support.piers);
        supports.decks.push(...support.decks);
      } else {
        // 橋台候補: upperを持たない線路セルから見て、隣が橋桁(upper)なら
        // その方向へ擁壁を置く(地平の高さから桁下面までを埋める)。
        // ramp(坂)を持つ方向は、上のbuildRampAbutmentPartがくさび状の擁壁を
        // 既に置いているので、段差の直方体擁壁は重ねて描かない
        // (rampが無い旧セーブの橋台は従来どおりここで段差の擁壁を描く)。
        for (const bit of DIR_BITS) {
          if (!((data.connections ?? 0) & bit)) continue;
          if (data.ramp?.dir === bit) continue;
          const v = DIR_VECTORS[bit];
          const neighbour = railMap.get(`${x + v.x},${z + v.z}`);
          if (!neighbour?.upper) continue;
          if (!(neighbour.upper.connections & getOppositeDir(bit))) continue;
          const abutment = buildBridgeAbutmentPart(bit, x, z, OVERPASS_HEIGHT);
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

  return (
    <group>
      {merged.decks && <mesh geometry={merged.decks} material={MATERIALS.overpassDeck} castShadow receiveShadow />}
      {merged.piers && <mesh geometry={merged.piers} material={MATERIALS.overpassPier} castShadow receiveShadow />}
      {merged.abutments && (
        <mesh geometry={merged.abutments} material={MATERIALS.overpassPier} castShadow receiveShadow />
      )}
      {merged.ballast && <mesh geometry={merged.ballast} material={MATERIALS.ballast} receiveShadow />}
      {merged.sleepers && <mesh geometry={merged.sleepers} material={MATERIALS.sleeper} receiveShadow />}
      {merged.rails && <mesh geometry={merged.rails} material={MATERIALS.rail as THREE.Material} castShadow />}
    </group>
  );
};
