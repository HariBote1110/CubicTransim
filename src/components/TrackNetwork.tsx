import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import { fromKey } from '../utils';
import { MATERIALS } from '../render/palette';
import { buildCellTrackParts, mergeParts, type TrackParts } from '../render/trackGeometry';

interface Props {
  railMap: Map<string, CellData>;
}

/**
 * 敷設済みの線路(バラスト・枕木・レール)をまとめて描画する。
 *
 * セルごとにmeshを作ると数百セルで数千ドローコールになるため、マテリアル単位で
 * ジオメトリをマージし、線路網全体を3つのmeshで描く。railMapが変わるたびに
 * 作り直し、古いジオメトリはuseEffectのクリーンアップで確実に破棄する。
 */
export const TrackNetwork: React.FC<Props> = ({ railMap }) => {
  const merged = useMemo(() => {
    const all: TrackParts = { ballast: [], sleepers: [], rails: [] };
    for (const [key, data] of railMap) {
      // 車庫セルは建屋を描くため線路は敷かない(建屋側で床を描く)。
      if (data.type === 'depot') continue;
      const { x, z } = fromKey(key);
      const parts = buildCellTrackParts(data.connections ?? 0, x, z);
      all.ballast.push(...parts.ballast);
      all.sleepers.push(...parts.sleepers);
      all.rails.push(...parts.rails);
    }
    return {
      ballast: mergeParts(all.ballast),
      sleepers: mergeParts(all.sleepers),
      rails: mergeParts(all.rails),
    };
  }, [railMap]);

  useEffect(() => () => {
    merged.ballast?.dispose();
    merged.sleepers?.dispose();
    merged.rails?.dispose();
  }, [merged]);

  return (
    <group>
      {merged.ballast && <mesh geometry={merged.ballast} material={MATERIALS.ballast} receiveShadow />}
      {merged.sleepers && <mesh geometry={merged.sleepers} material={MATERIALS.sleeper} receiveShadow />}
      {merged.rails && <mesh geometry={merged.rails} material={MATERIALS.rail as THREE.Material} castShadow />}
    </group>
  );
};
