import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { CellData } from '../types';
import type { TerrainField } from '../sim/terrainField';
import { DIR, fromKey, getOppositeDir } from '../utils';
import { materialsFor, MATERIALS, DIMMED_MATERIALS } from '../render/palette';
import {
  buildBridgeAbutmentPart, buildCellTrackParts, buildGroundInclineTrackParts, buildOverpassSupportParts,
  mergeParts, buildRampTrackParts, buildRampAbutmentPart, buildRampPierPart, shouldPlacePier,
  buildUndergroundOpeningPart,
  type TrackParts, type SupportParts,
} from '../render/trackGeometry';
import {
  OVERPASS_HEIGHT, MAX_ELEVATED_LEVEL, rampHeightAtPos, rampSegmentPositions,
} from '../sim/trackPath';
import { railRenderHeight } from '../sim/slopes';
import { ALL_LEVELS } from '../sim/construction';

// 高架のレベル1〜MAX_ELEVATED_LEVELを走査するための配列([1,2,3])。
const ELEVATED_LEVELS = Array.from({ length: MAX_ELEVATED_LEVEL }, (_, i) => (i + 1) as 1 | 2 | 3);

interface Props {
  railMap: Map<string, CellData>;
  /** 地形field(P7c)。地上区間の勾配追従(flat/incline/tunnelの高さ)に使う。 */
  field: TerrainField;
  /** P8b: 地下ビュー中かどうか(GameSceneのbuildLevel<0)。 */
  undergroundView?: boolean;
  /** P8b: 地下ビュー中に選択中のレベル(buildLevel)。地下ビューでないときは無視される。 */
  selectedLevel?: number;
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

const emptyTrackParts = (): TrackParts => ({ ballast: [], sleepers: [], rails: [] });

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
  const merged = useMemo(() => {
    const surface: TrackParts = emptyTrackParts();
    const supports: SupportParts = { piers: [], decks: [] };
    const abutments: THREE.BufferGeometry[] = [];

    const undergroundBright: TrackParts = emptyTrackParts();
    const undergroundDim: TrackParts = emptyTrackParts();
    const openings: THREE.BufferGeometry[] = [];

    // 地下ランプ(base<0)が選択中レベルに対して「今アクティブ(bright)」かどうか。
    // ランプはbase〜base+1の1段を繋ぐので、選択レベルがどちらかの端に一致すれば良い。
    const undergroundRampIsActive = (base: number): boolean =>
      selectedLevel === base || selectedLevel === base + 1;

    for (const [key, data] of railMap) {
      // 車庫セルは建屋を描くため線路は敷かない(建屋側で床を描く)。
      if (data.type === 'depot') continue;
      const { x, z } = fromKey(key);

      // 坂(ramp)セルは、桁側へ向かう軸ビットだけ地平の平坦な部品から除外し、
      // 代わりに斜めに登る専用パーツ(buildRampTrackParts)で描く。
      // 交差する別方向の接続(あれば)は平坦なままでよいので軸ビットだけ除く。
      const rampAxisBits = data.ramp ? (data.ramp.dir | getOppositeDir(data.ramp.dir)) : 0;
      const flatConnections = (data.connections ?? 0) & ~rampAxisBits;

      // 地平の高さ(P7c): flat/tunnelは単一のY、incline(傾斜地)は低い側→高い側の
      // 直線として描く(sim/slopes.tsのrailRenderHeightがsimと共通の高さ式)。
      const renderHeight = railRenderHeight(field, data, x, z);
      if (renderHeight.kind === 'incline') {
        const inclineParts = buildGroundInclineTrackParts(
          renderHeight.dir, x, z, renderHeight.lowY, renderHeight.highY,
        );
        surface.ballast.push(...inclineParts.ballast);
        surface.sleepers.push(...inclineParts.sleepers);
        surface.rails.push(...inclineParts.rails);
      } else {
        const parts = buildCellTrackParts(flatConnections, x, z, renderHeight.y);
        surface.ballast.push(...parts.ballast);
        surface.sleepers.push(...parts.sleepers);
        surface.rails.push(...parts.rails);
      }

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

        if (base >= 0) {
          // 高架側(従来どおり、常にsurfaceバケットへ)。
          surface.ballast.push(...rampParts.ballast);
          surface.sleepers.push(...rampParts.sleepers);
          surface.rails.push(...rampParts.rails);

          if (base === 0 && level === 1) {
            // 地平(base=0)に接するlevel1側だけ、従来どおり土盛りのくさびで支える。
            // 地平(pos=0)で高さ0に収束するようbuildRampAbutmentPart側のposLowは0のまま渡す。
            const wedge = buildRampAbutmentPart(data.ramp.dir, x, z, posHigh, posLow);
            if (wedge) abutments.push(wedge);
          } else {
            // それ以外(base>=1のlevel1、およびlevel2は常に)は地平に接しない
            // (空中に架かる)ので、土盛りではなく支柱で支える。
            const heightAtLowEnd = rampHeightAtPos(posLow, base);
            if (shouldPlacePier(x, z, data.ramp.dir)) {
              const pier = buildRampPierPart(x, z, heightAtLowEnd);
              if (pier) supports.piers.push(pier);
            }
          }
        } else {
          // P8b: 地下側の掘割ランプ(base<0)。土に埋まっているので支柱・砂利は描かず、
          // 通常表示(!undergroundView)では枕木・レールも隠し、浅い側(base===-1)の
          // セルにだけ地表の開口部(書き割り)を出す。地下ビュー中は選択レベルとの
          // 一致でbright/dimに振り分ける。
          if (undergroundView) {
            const bucket = undergroundRampIsActive(base) ? undergroundBright : undergroundDim;
            bucket.sleepers.push(...rampParts.sleepers);
            bucket.rails.push(...rampParts.rails);
            if (base === -1) {
              bucket.ballast.push(...rampParts.ballast);
            }
          } else if (base === -1) {
            const opening = buildUndergroundOpeningPart(data.ramp.dir, x, z);
            if (opening) openings.push(opening.pit, opening.wallA, opening.wallB);
          }
        }
      }

      // 高架は全レベル(1〜MAX_ELEVATED_LEVEL)を、地下は全レベル(-1〜-MAX_ELEVATED_LEVEL)を
      // 走査し、レベルLの線路をoriginY = L * OVERPASS_HEIGHTで生成する。
      // 異なるレベルの桁/地下線は同一セルに併存しうる。
      for (const level of ALL_LEVELS) {
        const upper = data.uppers?.[level];
        if (!upper) continue;

        // 多段の坂セル(base>=1、または地下のbase<=-1)は、construction.tsの
        // orIntoBaseLevelが坂の軸ビットをuppers[base].connectionsへ書き込む。
        // そのビットをこのループが平坦な桁/地下線として描くと、坂の専用パーツ
        // (buildRampTrackParts)と二重描画になる(地平のconnectionsからrampAxisBitsを
        // 除くのと同じ理屈で、baseレベルからも除く)。坂の軸と交差する別方向の
        // 接続(あれば)は平坦なまま残す。
        const upperConnections = data.ramp && (data.ramp.base ?? 0) === level
          ? upper.connections & ~rampAxisBits
          : upper.connections;
        if (upperConnections === 0) continue;
        const originY = level * OVERPASS_HEIGHT;

        if (level > 0) {
          // 高架側はバラストを敷かず、枕木とレールだけを桁の上に置く(常にsurfaceバケット)。
          const upperParts = buildCellTrackParts(upperConnections, x, z, originY, false);
          surface.sleepers.push(...upperParts.sleepers);
          surface.rails.push(...upperParts.rails);

          const support = buildOverpassSupportParts(upperConnections, x, z, originY);
          supports.piers.push(...support.piers);
          supports.decks.push(...support.decks);
        } else {
          // 地下側: 通常表示では一切描かない(掘割の開口だけが目印になる)。
          // 地下ビュー中は選択レベルとの一致でbright/dimに振り分ける。土中なので
          // 桁・支柱・バラストは無し(枕木とレールだけ)。
          if (!undergroundView) continue;
          const upperParts = buildCellTrackParts(upperConnections, x, z, originY, false);
          const bucket = level === selectedLevel ? undergroundBright : undergroundDim;
          bucket.sleepers.push(...upperParts.sleepers);
          bucket.rails.push(...upperParts.rails);
        }
      }

      // 橋台候補: あるレベルLの桁を持たない線路セルから見て、隣がそのレベルの桁なら
      // その方向へ擁壁を置く(地平の高さから桁下面までを埋める)。地下は空中に架からない
      // ので橋台は無い(高架レベルのみ対象、従来どおり)。
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
      openings: mergeParts(openings),
    };
  }, [railMap, field, undergroundView, selectedLevel]);

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
        <mesh geometry={merged.surface.decks} material={surfaceMaterials.overpassDeck} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.surface.piers && (
        <mesh geometry={merged.surface.piers} material={surfaceMaterials.overpassPier} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.surface.abutments && (
        <mesh geometry={merged.surface.abutments} material={surfaceMaterials.overpassPier} castShadow receiveShadow raycast={noRaycast} />
      )}
      {merged.surface.ballast && <mesh geometry={merged.surface.ballast} material={surfaceMaterials.ballast} receiveShadow raycast={noRaycast} />}
      {merged.surface.sleepers && <mesh geometry={merged.surface.sleepers} material={surfaceMaterials.sleeper} receiveShadow raycast={noRaycast} />}
      {merged.surface.rails && (
        <mesh geometry={merged.surface.rails} material={surfaceMaterials.rail as THREE.Material} castShadow raycast={noRaycast} />
      )}

      {/* 地下ビュー中のみ: 選択レベルの地下線(通常輝度)+それ以外の地下線(暗い)。 */}
      {undergroundView && merged.undergroundBright.ballast && (
        <mesh geometry={merged.undergroundBright.ballast} material={MATERIALS.ballast} receiveShadow raycast={noRaycast} />
      )}
      {undergroundView && merged.undergroundBright.sleepers && (
        <mesh geometry={merged.undergroundBright.sleepers} material={MATERIALS.sleeper} receiveShadow raycast={noRaycast} />
      )}
      {undergroundView && merged.undergroundBright.rails && (
        <mesh geometry={merged.undergroundBright.rails} material={MATERIALS.rail as THREE.Material} castShadow raycast={noRaycast} />
      )}
      {undergroundView && merged.undergroundDim.ballast && (
        <mesh geometry={merged.undergroundDim.ballast} material={DIMMED_MATERIALS.ballast} raycast={noRaycast} />
      )}
      {undergroundView && merged.undergroundDim.sleepers && (
        <mesh geometry={merged.undergroundDim.sleepers} material={DIMMED_MATERIALS.sleeper} raycast={noRaycast} />
      )}
      {undergroundView && merged.undergroundDim.rails && (
        <mesh geometry={merged.undergroundDim.rails} material={DIMMED_MATERIALS.rail as THREE.Material} raycast={noRaycast} />
      )}

      {/* 通常表示のみ: 掘割ランプの地表開口(暗い穴+短い擁壁)。 */}
      {!undergroundView && merged.openings && (
        <mesh geometry={merged.openings} material={MATERIALS.undergroundPit} receiveShadow raycast={noRaycast} />
      )}
    </group>
  );
};
