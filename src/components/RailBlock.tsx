import React, { useEffect, useMemo } from 'react';
import { MATERIALS } from '../render/palette';
import { buildCellTrackParts, mergeParts } from '../render/trackGeometry';

interface RailBlockProps {
  position: [number, number, number];
  connections?: number;
  isPreview?: boolean;
}

/**
 * 単一セルの線路描画。建設プレビュー(まだrailMapに入っていないセル)専用。
 *
 * 敷設済みの線路は TrackNetwork がネットワーク全体をマージして描くため、
 * このコンポーネントは1セルぶんだけを扱う。ジオメトリの作り方は共通の
 * buildCellTrackParts に寄せてあるので、プレビューと実物の見た目は一致する。
 */
export const RailBlock: React.FC<RailBlockProps> = ({ position, connections = 0, isPreview = false }) => {
  const merged = useMemo(() => {
    const parts = buildCellTrackParts(connections);
    return {
      ballast: mergeParts(parts.ballast),
      sleepers: mergeParts(parts.sleepers),
      rails: mergeParts(parts.rails),
    };
  }, [connections]);

  useEffect(() => () => {
    merged.ballast?.dispose();
    merged.sleepers?.dispose();
    merged.rails?.dispose();
  }, [merged]);

  return (
    <group position={position}>
      {merged.ballast && <mesh geometry={merged.ballast} material={MATERIALS.ballast} />}
      {merged.sleepers && <mesh geometry={merged.sleepers} material={MATERIALS.sleeper} />}
      {merged.rails && <mesh geometry={merged.rails} material={MATERIALS.rail} />}
      {isPreview && (
        <mesh position={[0, 0.07, 0]}>
          <boxGeometry args={[0.94, 0.14, 0.94]} />
          <meshBasicMaterial color="#3ab6ff" transparent opacity={0.28} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
};
