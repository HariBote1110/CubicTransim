import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { TerrainField } from '../sim/terrainField';
import { TERRAIN_HEIGHT_MAX } from '../sim/terrainField';
import { OVERPASS_HEIGHT } from '../sim/trackPath';
import { materialsFor } from '../render/palette';
import { SURFACE_RENDER_ORDER } from '../render/viewMode';
import { mergeAndDispose } from '../render/mergeGeometry';
import type { CornerDiffs } from '../sim/terrainOverlay';
import { overlayChunkRefs } from '../sim/terrainOverlay';
import {
  chunkKey, chunkCellBounds, visibleChunkRange, type ChunkCoord,
} from '../render/terrainChunks';

interface Props {
  field: TerrainField;
  /** マップの生成半径(-halfExtent..halfExtentのセルを走査する)。 */
  halfExtent: number;
  /**
   * 地形編集の疎な差分(useGameLogicのcornerDiffs)。チャンクごとの描画キャッシュの
   * 無効化判定(overlayChunkRefs)に使う。省略時は「編集なし」として扱う。
   */
  diffs?: CornerDiffs;
  /** カメラが注視しているセル座標(チャンク描画の中心)。 */
  cameraTargetCell: { x: number; z: number };
  /** カメラの可視半径(セル数)。この範囲＋マージン1チャンクぶんだけチャンクを実体化する。 */
  viewRadiusCells: number;
  /**
   * trueのとき、地形の上面メッシュ(草地・雪)をポインタで拾えるようにし、
   * 渡されたハンドラを発火させる(地形編集モード用。e.pointが実際の地表に当たるので、
   * 高い地形でも真上のセルが正しく選べる)。falseのときは従来通り装飾扱いで
   * レイキャストを外し、地面クリックを奪わない。
   */
  pickable?: boolean;
  onPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void;
  /** P8b: 地下ビュー中は地表を暗く半透明にする(render/palette.tsのDIMMED_MATERIALS)。 */
  dimmed?: boolean;
}

// この標高以上の上面を雪化粧にする(最大段数に対する相対しきい値)。
const SNOW_HEIGHT_MIN = TERRAIN_HEIGHT_MAX - 2;

const WATER_LEVEL = -0.07;

// セル(x,z)の4隅の平面座標。cellCornerElevationsと同じ順序[左上,右上,右下,左下]。
const CORNER_OFFSETS: ReadonlyArray<[number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

const pushTri = (
  target: THREE.BufferGeometry[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
): void => {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  target.push(geo);
};

interface ChunkMerged {
  water: THREE.BufferGeometry | null;
  shore: THREE.BufferGeometry | null;
  rock: THREE.BufferGeometry | null;
  rockDark: THREE.BufferGeometry | null;
  grassTop: THREE.BufferGeometry | null;
  snowTop: THREE.BufferGeometry | null;
}

/**
 * 1チャンクぶんのセル範囲([x0,x1]×[z0,z1])から地形メッシュ(マテリアル別マージ済み)を
 * 構築する。TerrainBlocksが以前(P3まで)全域を1回でこの処理をしていたものを、
 * チャンク単位で呼べるよう関数として切り出したもの(見た目・判定ロジックは変更なし)。
 */
function buildChunkGeometry(
  field: TerrainField,
  bounds: { x0: number; x1: number; z0: number; z1: number },
): ChunkMerged {
  const water: THREE.BufferGeometry[] = [];
  const shore: THREE.BufferGeometry[] = [];
  const rock: THREE.BufferGeometry[] = [];
  const rockDark: THREE.BufferGeometry[] = [];
  const grassTop: THREE.BufferGeometry[] = [];
  const snowTop: THREE.BufferGeometry[] = [];

  for (let x = bounds.x0; x <= bounds.x1; x++) {
    for (let z = bounds.z0; z <= bounds.z1; z++) {
      const type = field.terrainTypeAt(x, z);

      if (type === 'water') {
        // 岸: セル全体を砂色で塗り、その内側に水面を張る。
        // 水域の外周セルだけ縁が見えるので、自然に汀線ができる。
        const bank = new THREE.BoxGeometry(1.0, 0.08, 1.0);
        bank.translate(x, WATER_LEVEL - 0.02, z);
        shore.push(bank);

        const surface = new THREE.BoxGeometry(0.94, 0.05, 0.94);
        surface.translate(x, WATER_LEVEL + 0.02, z);
        water.push(surface);
        continue;
      }

      // mountain(トンネル敷設済みセルもOpenTTD風に地形メッシュへ埋め込んで描く。
      // 坑口はGameScene側でtunnelPortalsを使い山肌の位置に別途表示する)
      const e = field.cellHeightAt(x, z);
      if (e <= 0) continue;

      const corners = field.cellCornerHeights(x, z);
      const worldCorners = corners.map((h, i) => {
        const [ox, oz] = CORNER_OFFSETS[i];
        return new THREE.Vector3(x + ox, h * OVERPASS_HEIGHT, z + oz);
      });
      const [tl, tr, br, bl] = worldCorners;

      // 上面の色: 高標高(SNOW_HEIGHT_MIN以上)は雪、それ以外は草地(斜面も同じ扱いでよい)。
      const topTarget = e >= SNOW_HEIGHT_MIN ? snowTop : grassTop;

      // 対角線は「高さが等しい2隅を結ぶ側」を優先して分割する(ひねりの少ない自然な見た目になる)。
      // 頂点順は+Y(上方)から見てCCW(反時計回り)にすること。
      if (corners[0] === corners[2]) {
        pushTri(topTarget, tl, br, tr);
        pushTri(topTarget, tl, bl, br);
      } else if (corners[1] === corners[3]) {
        pushTri(topTarget, tl, bl, tr);
        pushTri(topTarget, tr, bl, br);
      } else {
        pushTri(topTarget, tl, br, tr);
        pushTri(topTarget, tl, bl, br);
      }
    }
  }

  const mergeAll = (list: THREE.BufferGeometry[]): THREE.BufferGeometry | null => {
    const geo = mergeAndDispose(list);
    geo?.computeVertexNormals();
    return geo;
  };

  return {
    water: mergeAll(water),
    shore: mergeAll(shore),
    rock: mergeAll(rock),
    rockDark: mergeAll(rockDark),
    grassTop: mergeAll(grassTop),
    snowTop: mergeAll(snowTop),
  };
}

function disposeChunkMerged(merged: ChunkMerged): void {
  merged.water?.dispose();
  merged.shore?.dispose();
  merged.rock?.dispose();
  merged.rockDark?.dispose();
  merged.grassTop?.dispose();
  merged.snowTop?.dispose();
}

const sameRefs = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

interface ChunkCacheEntry {
  bounds: { x0: number; x1: number; z0: number; z1: number };
  overlayRefs: ReadonlyArray<Map<number, number>>;
  merged: ChunkMerged;
}

// キャッシュ上限(チャンク数)。可視集合より十分大きく取り、パン操作の往復で
// 直前まで見えていたチャンクの再構築を避けつつ、無限に溜め込まないようにする。
const CHUNK_CACHE_LIMIT = 256;
// マージン込みの可視チャンク+この余白ぶんは、直近まで見えていたチャンクとして
// キャッシュに残す(視界の端で毎フレーム破棄・再構築を繰り返すのを避ける)。
const EVICT_MARGIN = 1;

/**
 * 地形(水域・山岳)の描画。
 *
 *  - 水域: 一段掘り下げた水面 + 岸(砂色の縁)で湖らしく
 *  - 山岳: OpenTTD風に、隣接セルとの標高差を斜面で繋いだ地形メッシュ。
 *  1段の高さは OVERPASS_HEIGHT に合わせ、将来の高架・トンネルと視覚整合させる。
 *
 * P4でチャンク描画化した: 全セルを毎回スキャンするのではなく、カメラの可視範囲
 * (cameraTargetCell±viewRadiusCells)にマージンを足したチャンク(32×32セル)だけを
 * render/terrainChunks.tsのvisibleChunkRangeで求め、チャンクごとにマージ済み
 * ジオメトリを構築・キャッシュする。地形編集(盛土/切土)はterrainOverlay.tsの
 * overlayChunkRefsが返す「重なるオーバーレイチャンクのサブMap参照」をキャッシュキーの
 * 一部として使うことで、編集で触れていないチャンクは再構築しない
 * (immutable replaceにより参照が変わらないチャンクは同一参照のまま)。
 * これにより描画コストがマップサイズではなく可視セル数に依存するようになる
 * (詳細は progress/16k-map-architecture.md の「P4実装メモ」参照)。
 */
export const TerrainBlocks: React.FC<Props> = ({
  field, halfExtent, diffs, cameraTargetCell, viewRadiusCells,
  pickable = false, onPointerMove, onPointerDown, onPointerUp, dimmed = false,
}) => {
  const MATERIALS = materialsFor(dimmed);
  const cacheRef = useRef<Map<string, ChunkCacheEntry>>(new Map());

  const visibleChunks = useMemo(
    () => visibleChunkRange(cameraTargetCell, viewRadiusCells, halfExtent, 1),
    [cameraTargetCell.x, cameraTargetCell.z, viewRadiusCells, halfExtent],
  );

  const chunkEntries = useMemo(() => {
    const cache = cacheRef.current;
    const emptyDiffs: CornerDiffs = new Map();
    const activeDiffs = diffs ?? emptyDiffs;
    const visibleKeySet = new Set<string>();
    let rebuilds = 0;

    const entries: { key: string; chunk: ChunkCoord; merged: ChunkMerged }[] = [];
    for (const chunk of visibleChunks) {
      const bounds = chunkCellBounds(chunk, halfExtent);
      if (!bounds) continue; // マップ範囲外(halfExtentでクランプ済みのはずだが念のため)。
      const key = chunkKey(chunk.cx, chunk.cz);
      visibleKeySet.add(key);

      const overlayRefs = overlayChunkRefs(activeDiffs, bounds);
      const cached = cache.get(key);
      if (cached && sameRefs(cached.overlayRefs, overlayRefs)) {
        entries.push({ key, chunk, merged: cached.merged });
        continue;
      }

      // キャッシュ無し、または地形編集でこのチャンクに重なるオーバーレイが変わった
      // ときだけ再構築する。
      if (cached) disposeChunkMerged(cached.merged);
      const merged = buildChunkGeometry(field, bounds);
      cache.set(key, { bounds, overlayRefs, merged });
      entries.push({ key, chunk, merged });
      rebuilds++;
    }

    // 破棄: 可視範囲(マージン込み)から十分離れたチャンクをキャッシュから追い出す。
    if (cache.size > CHUNK_CACHE_LIMIT) {
      for (const [key, entry] of cache) {
        if (visibleKeySet.has(key)) continue;
        const [cxStr, czStr] = key.split(',');
        const cx = Number(cxStr);
        const cz = Number(czStr);
        const withinMargin = visibleChunks.some(
          c => Math.abs(c.cx - cx) <= EVICT_MARGIN && Math.abs(c.cz - cz) <= EVICT_MARGIN,
        );
        if (withinMargin) continue;
        disposeChunkMerged(entry.merged);
        cache.delete(key);
        if (cache.size <= CHUNK_CACHE_LIMIT) break;
      }
    }

    // ブラウザ検証用のデバッグ統計(window.__debugWorld等の既存の慣行に合わせる)。
    if (typeof window !== 'undefined') {
      (window as any).__terrainChunkStats = {
        visible: visibleChunks.length,
        cached: cache.size,
        rebuiltThisPass: rebuilds,
      };
    }

    return entries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, halfExtent, diffs, visibleChunks]);

  // アンマウント時は全キャッシュを破棄する。
  useEffect(() => () => {
    for (const entry of cacheRef.current.values()) disposeChunkMerged(entry.merged);
    cacheRef.current.clear();
  }, []);

  // 水域・山岳の地形装飾は選択対象ではない。地面クリックを奪わないようレイキャストを外す。
  const noRaycast = () => null;

  // 地形編集モード(pickable)のときだけ、上面メッシュにポインタハンドラを付ける。
  const topFaceProps = pickable
    ? { raycast: THREE.Mesh.prototype.raycast, onPointerMove, onPointerDown, onPointerUp }
    : { raycast: noRaycast };

  return (
    <group>
      {chunkEntries.map(({ key, merged }) => (
        <group key={key}>
          {merged.shore && <mesh geometry={merged.shore} material={MATERIALS.shore} receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
          {merged.water && <mesh geometry={merged.water} material={MATERIALS.water} raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />}
          {merged.rock && (
            <mesh geometry={merged.rock} material={MATERIALS.rock} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
          )}
          {merged.rockDark && (
            <mesh geometry={merged.rockDark} material={MATERIALS.rockDark} castShadow receiveShadow raycast={noRaycast} renderOrder={SURFACE_RENDER_ORDER} />
          )}
          {merged.grassTop && (
            <mesh
              geometry={merged.grassTop}
              material={MATERIALS.grassTerrace}
              castShadow
              receiveShadow
              renderOrder={SURFACE_RENDER_ORDER}
              {...topFaceProps}
            />
          )}
          {merged.snowTop && (
            <mesh
              geometry={merged.snowTop}
              material={MATERIALS.rockSnow}
              castShadow
              receiveShadow
              renderOrder={SURFACE_RENDER_ORDER}
              {...topFaceProps}
            />
          )}
        </group>
      ))}
    </group>
  );
};
