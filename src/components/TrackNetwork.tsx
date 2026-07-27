import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import { fromKey } from '../utils';
import { MATERIALS } from '../render/palette';
import {
  buildCellTrackParts, buildOverpassSupportParts, mergeParts, type TrackParts, type SupportParts,
} from '../render/trackGeometry';
import { OVERPASS_HEIGHT } from '../sim/trackPath';

interface Props {
  railMap: Map<string, CellData>;
}

/**
 * 敷設済みの線路(バラスト・枕木・レール)をまとめて描画する。
 *
 * セルごとにmeshを作ると数百セルで数千ドローコールになるため、マテリアル単位で
 * ジオメトリをマージし、線路網全体をまとめたmeshで描く。railMapが変わるたびに
 * 作り直し、古いジオメトリはuseEffectのクリーンアップで確実に破棄する。
 *
 * 立体交差(cell.upper)を持つセルは、地平の線路に加えて OVERPASS_HEIGHT ぶん
 * 持ち上げた高架側の線路と、それを支える橋脚・桁(デッキ)を追加で描く。
 */
export const TrackNetwork: React.FC<Props> = ({ railMap }) => {
  const merged = useMemo(() => {
    const all: TrackParts = { ballast: [], sleepers: [], rails: [] };
    const supports: SupportParts = { piers: [], decks: [] };
    for (const [key, data] of railMap) {
      // 車庫セルは建屋を描くため線路は敷かない(建屋側で床を描く)。
      if (data.type === 'depot') continue;
      const { x, z } = fromKey(key);
      const parts = buildCellTrackParts(data.connections ?? 0, x, z);
      all.ballast.push(...parts.ballast);
      all.sleepers.push(...parts.sleepers);
      all.rails.push(...parts.rails);

      if (data.upper) {
        const upperParts = buildCellTrackParts(data.upper.connections, x, z, OVERPASS_HEIGHT);
        all.ballast.push(...upperParts.ballast);
        all.sleepers.push(...upperParts.sleepers);
        all.rails.push(...upperParts.rails);

        const support = buildOverpassSupportParts(x, z, OVERPASS_HEIGHT);
        supports.piers.push(...support.piers);
        supports.decks.push(...support.decks);
      }
    }
    return {
      ballast: mergeParts(all.ballast),
      sleepers: mergeParts(all.sleepers),
      rails: mergeParts(all.rails),
      piers: mergeParts(supports.piers),
      decks: mergeParts(supports.decks),
    };
  }, [railMap]);

  useEffect(() => () => {
    merged.ballast?.dispose();
    merged.sleepers?.dispose();
    merged.rails?.dispose();
    merged.piers?.dispose();
    merged.decks?.dispose();
  }, [merged]);

  return (
    <group>
      {merged.decks && <mesh geometry={merged.decks} material={MATERIALS.overpassDeck} castShadow receiveShadow />}
      {merged.piers && <mesh geometry={merged.piers} material={MATERIALS.overpassPier} castShadow receiveShadow />}
      {merged.ballast && <mesh geometry={merged.ballast} material={MATERIALS.ballast} receiveShadow />}
      {merged.sleepers && <mesh geometry={merged.sleepers} material={MATERIALS.sleeper} receiveShadow />}
      {merged.rails && <mesh geometry={merged.rails} material={MATERIALS.rail as THREE.Material} castShadow />}
    </group>
  );
};
