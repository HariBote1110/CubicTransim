import React, { useEffect, useMemo } from 'react';
import type { CellData } from '../types';
import type { TownTileIndex } from '../sim/townTiles';
import { materialsFor } from '../render/palette';
import { SURFACE_RENDER_ORDER } from '../render/viewMode';
import type { TerrainField } from '../sim/terrainField';
import { visibleChunkRange } from '../render/terrainChunks';
import { treeCandidatesInChunk, buildSceneryGeometries } from '../render/sceneryGeometry';

interface Props {
  field: TerrainField;
  railMap: Map<string, CellData>;
  /** 町タイル索引(sim/townTiles.tsのbuildTownTileIndex)。市街地には樹木を置かない。 */
  townTiles: TownTileIndex;
  /** 装飾を置く範囲(-RANGE..RANGE)。sim/terrain.ts の生成範囲に合わせる。 */
  range?: number;
  /** カメラが注視しているセル座標(TerrainBlocksと同じ可視チャンク集合を使う)。 */
  cameraTargetCell: { x: number; z: number };
  /** カメラの可視半径(セル数)。 */
  viewRadiusCells: number;
  /** P8b: 地下ビュー中は樹木を暗く半透明にする(render/palette.tsのDIMMED_MATERIALS)。 */
  dimmed?: boolean;
  /**
   * R3: trueのとき、樹木の候補セル列挙(visibleChunkRange)そのものを行わず何も描かない
   * (render/farView.tsのfarViewStageForRatioが'hidden'を返した場合。WebGPU全図
   * ズームアウトで可視半径がマップ全体に迫るとチャンク数が爆発するため、GameScene側で
   * 事前に見積もって止める)。
   */
  hidden?: boolean;
}

/**
 * 平地(草地)に置く装飾物(樹木)。従来(three.js)モード用。
 *
 * 候補セルの列挙とジオメトリ生成は render/sceneryGeometry.ts の純粋関数に置いてあり、
 * WebGPUモードのフィーダ(WebGpuScenery.tsx)と共有している。
 * 数百本規模になるのでマテリアルごとにジオメトリをマージして3ドローコールに収める。
 */
export const Scenery: React.FC<Props> = ({
  field, railMap, townTiles, range = 45, cameraTargetCell, viewRadiusCells, dimmed = false, hidden = false,
}) => {
  const MATERIALS = materialsFor(dimmed);
  // P4: 全セル(-range..range)を毎回走査するのではなく、TerrainBlocksと同じ
  // 可視チャンク集合(render/terrainChunks.ts)だけを候補にする。
  // R3: hiddenのときはvisibleChunkRange自体を呼ばない(配列生成コストと後段の全走査を
  // 両方避ける。GameScene側がrender/farView.tsの見積もりで事前に決めている)。
  const visibleChunks = useMemo(
    () => (hidden ? [] : visibleChunkRange(cameraTargetCell, viewRadiusCells, range, 1)),
    [cameraTargetCell.x, cameraTargetCell.z, viewRadiusCells, range, hidden],
  );

  const candidates = useMemo(
    () => visibleChunks.flatMap(chunk => treeCandidatesInChunk(field, townTiles, chunk, range)),
    [field, townTiles, range, visibleChunks],
  );

  const merged = useMemo(
    () => buildSceneryGeometries(candidates, railMap, field),
    [candidates, railMap, field],
  );

  useEffect(() => () => {
    Object.values(merged).forEach(g => g?.dispose());
  }, [merged]);

  // 樹木は装飾であり選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  return (
    <group>
      {merged.trunks && <mesh geometry={merged.trunks} material={MATERIALS.trunk} raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.foliage && <mesh geometry={merged.foliage} material={MATERIALS.foliage} castShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.foliageDark && (
        <mesh geometry={merged.foliageDark} material={MATERIALS.foliageDark} castShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}
    </group>
  );
};
