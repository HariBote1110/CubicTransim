import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { materialsFor, MATERIALS, DIMMED_MATERIALS } from '../render/palette';
import { buildRailNetworkGeometry } from '../render/railGeometry';
import { SURFACE_RENDER_ORDER, UNDERGROUND_RENDER_ORDER } from '../render/viewMode';

interface Props {
  railMap: Map<string, CellData>;
  /** 地形field(P7c)。地上区間の勾配追従(flat/incline/tunnelの高さ)に使う。 */
  field: TerrainField;
  /** P8b: 地下ビュー中かどうか(GameSceneのbuildLevel<0)。 */
  undergroundView?: boolean;
  /** P8b: 地下ビュー中に選択中のレベル(buildLevel)。地下ビューでないときは無視される。 */
  selectedLevel?: number;
}

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
 *
 * P8b: 地下(uppers[-1..-3]・ramp.base<0)は「surface」(地平+高架、常時表示)とは
 * 別バケットで管理する。通常表示では地下の線路そのものは一切描かず、掘割ランプの
 * 浅い側(地表に接するセル)だけに開口部の書き割りを出す。地下ビュー中は、
 * 選択中のレベルに一致する地下だけ通常輝度(bright)、それ以外の地下(と地平・高架)は
 * 暗く半透明(dimmed)で描く(surface側の暗さはコンポーネント側でMATERIALS/
 * DIMMED_MATERIALSを丸ごと切り替えるだけで済ませる)。
 */
export const TrackNetwork: React.FC<Props> = ({ railMap, field, undergroundView = false, selectedLevel = 0 }) => {
  const merged = useMemo(
    () => buildRailNetworkGeometry(railMap, field, undergroundView, selectedLevel),
    [railMap, field, undergroundView, selectedLevel],
  );

  useEffect(() => () => {
    merged.surface.ballast?.dispose();
    merged.surface.sleepers?.dispose();
    merged.surface.rails?.dispose();
    merged.surface.piers?.dispose();
    merged.surface.decks?.dispose();
    merged.surface.abutments?.dispose();
    merged.undergroundBright.ballast?.dispose();
    merged.undergroundBright.sleepers?.dispose();
    merged.undergroundBright.rails?.dispose();
    merged.undergroundDim.ballast?.dispose();
    merged.undergroundDim.sleepers?.dispose();
    merged.undergroundDim.rails?.dispose();
    merged.openings?.dispose();
  }, [merged]);

  // 線路・高架桁・支柱・橋台は「クリックして選ぶ対象」ではない。react-three-fiberの
  // レイキャストを素通しにしないと、真下の地平セル(駅設置クリックなど)がヒットせず
  // 選べなくなる不具合(立体交差セルで駅が置けない)の原因になる。raycast={() => null}
  // でこれらのメッシュ自体をレイキャスト対象から外し、地面プレーンへ届かせる。
  const noRaycast = () => null;

  // 地下ビュー中は地平・高架(surface)全体を暗く半透明にする(選択中の地下レベルだけ
  // 通常輝度で別バケットから描く)。共有マテリアルの切替だけで済ませ、メッシュごとの
  // クローンはしない。
  const surfaceMaterials = materialsFor(undergroundView);

  return (
    <group>
      {merged.surface.decks && (
        <mesh geometry={merged.surface.decks} material={surfaceMaterials.overpassDeck} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}
      {merged.surface.piers && (
        <mesh geometry={merged.surface.piers} material={surfaceMaterials.overpassPier} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}
      {merged.surface.abutments && (
        <mesh geometry={merged.surface.abutments} material={surfaceMaterials.overpassPier} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}
      {merged.surface.ballast && <mesh geometry={merged.surface.ballast} material={surfaceMaterials.ballast} receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.surface.sleepers && <mesh geometry={merged.surface.sleepers} material={surfaceMaterials.sleeper} receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
      {merged.surface.rails && (
        <mesh geometry={merged.surface.rails} material={surfaceMaterials.rail as THREE.Material} castShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}

      {/* 地下ビュー中のみ: 選択レベルの地下線(通常輝度)+それ以外の地下線(暗い)。
          renderOrderをsurfaceより大きくし、three.jsの不透明/半透明キューの並びに
          頼らず「地表の後に必ず描く」ことを明示する(depthWrite:falseの地表越しに
          安定して見えるようにするため)。 */}
      {undergroundView && merged.undergroundBright.ballast && (
        <mesh geometry={merged.undergroundBright.ballast} material={MATERIALS.ballast} receiveShadow raycast={noRaycast} renderOrder={UNDERGROUND_RENDER_ORDER} />
      )}
      {undergroundView && merged.undergroundBright.sleepers && (
        <mesh geometry={merged.undergroundBright.sleepers} material={MATERIALS.sleeper} receiveShadow raycast={noRaycast} renderOrder={UNDERGROUND_RENDER_ORDER} />
      )}
      {undergroundView && merged.undergroundBright.rails && (
        <mesh geometry={merged.undergroundBright.rails} material={MATERIALS.rail as THREE.Material} castShadow raycast={noRaycast} renderOrder={UNDERGROUND_RENDER_ORDER} />
      )}
      {undergroundView && merged.undergroundDim.ballast && (
        <mesh geometry={merged.undergroundDim.ballast} material={DIMMED_MATERIALS.ballast} raycast={noRaycast} renderOrder={UNDERGROUND_RENDER_ORDER} />
      )}
      {undergroundView && merged.undergroundDim.sleepers && (
        <mesh geometry={merged.undergroundDim.sleepers} material={DIMMED_MATERIALS.sleeper} raycast={noRaycast} renderOrder={UNDERGROUND_RENDER_ORDER} />
      )}
      {undergroundView && merged.undergroundDim.rails && (
        <mesh geometry={merged.undergroundDim.rails} material={DIMMED_MATERIALS.rail as THREE.Material} raycast={noRaycast} renderOrder={UNDERGROUND_RENDER_ORDER} />
      )}

      {/* 通常表示のみ: 掘割ランプの地表開口(暗い穴+短い擁壁)。 */}
      {!undergroundView && merged.openings && (
        <mesh geometry={merged.openings} material={MATERIALS.undergroundPit} receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
      )}
    </group>
  );
};
