// R4a: 「可視集合(キーの一覧)」と「キー1つ分のメッシュを焼き込む関数」を受け取り、
// wgpu のメッシュチャンクを差分で載せ替える共有フック。
//
// 樹木(WebGpuScenery)と町(WebGpuTownBlocks)が同じ骨格を使う。R4b以降のレール網・
// 駅なども同じフックへ載せられる。
//
// 設計:
// - 可視集合から外れたキーは removeMeshChunk して台帳(MeshChunkRegistry)から外す
// - 新しく可視になったキーは1フレームあたり `budgetPerFrame` 件までしか構築しない
//   (パンで一気に数十チャンクが可視になってもヒッチしないよう分割する)
// - `version` が変わると全チャンクを作り直す(遠景フェードの段階が変わったときなど)
// - コントローラ(wasm)の生成は非同期なので、フレームごとに毎回 null チェックする

import { useEffect, useRef } from 'react';

import { FRAME_ORDER } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';
import type { BakedMeshChunk } from '../render/bakedMesh';
import { MeshChunkRegistry } from '../render/meshChunkRegistry';
import { MESH_LAYER_CLASS } from '../render/webgpuLayer';
import type { WebGpuTerrainLayerController } from '../render/webgpuLayer';
import type { WebGpuLayerRef } from './WebGpuTerrainLayer';

/** 1フレームで新規構築・アップロードするチャンクの上限。 */
export const MAX_CHUNK_UPLOADS_PER_FRAME = 6;

interface FeederOptions {
  layerRef: WebGpuLayerRef;
  /** id名前空間(render/meshChunkRegistry.ts の MESH_CHUNK_NAMESPACE)。 */
  namespace: number;
  /** いま可視であるべきキーの一覧(順序はそのまま優先度になる)。 */
  desiredKeys: readonly string[];
  /** キー1つ分のメッシュを焼き込む。中身が無ければ null を返す。 */
  buildChunk: (key: string) => BakedMeshChunk | null;
  /** 変わると全チャンクを作り直す識別値(焼き込み内容に影響する設定など)。 */
  version?: number;
  /** 描画クラス(既定は地表)。 */
  layerClass?: number;
  budgetPerFrame?: number;
}

export function useMeshChunkFeeder({
  layerRef,
  namespace,
  desiredKeys,
  buildChunk,
  version = 0,
  layerClass = MESH_LAYER_CLASS.surface,
  budgetPerFrame = MAX_CHUNK_UPLOADS_PER_FRAME,
}: FeederOptions): void {
  const registryRef = useRef<MeshChunkRegistry | null>(null);
  if (registryRef.current === null) registryRef.current = new MeshChunkRegistry(namespace);
  /** 最後に載せた相手のレンダラー(差し替わったら台帳を作り直す)。 */
  const lastControllerRef = useRef<WebGpuTerrainLayerController | null>(null);

  // フレームループから読む最新の入力(再レンダーのたびに差し替える)。
  const desiredRef = useRef(desiredKeys);
  const buildRef = useRef(buildChunk);
  const versionRef = useRef(version);
  const appliedVersionRef = useRef(version);
  // 「載せ替えるべき変更がある」フラグ。立っていないフレームでは何もしない。
  const dirtyRef = useRef(true);

  useEffect(() => {
    desiredRef.current = desiredKeys;
    buildRef.current = buildChunk;
    versionRef.current = version;
    dirtyRef.current = true;
  }, [desiredKeys, buildChunk, version]);

  // アンマウント時だけ、載せてあるチャンクをすべて外す。
  // (依存に関数を置くと、その関数の同一性が変わるたびにクリーンアップが走って
  //  全チャンクが消える。ここは必ず layerRef だけに依存させること)
  useEffect(() => () => {
    const controller = layerRef.current;
    const ids = registryRef.current!.clear();
    if (!controller) return;
    for (const id of ids) controller.removeMeshChunk(id);
  }, [layerRef]);

  useFrameLoop(FRAME_ORDER.feed, () => {
    const controller = layerRef.current;
    if (!controller) return;

    // 新しいレンダラーに差し替わった場合(新規ワールド生成・セーブ読込で
    // WebGpuTerrainLayer が seed/halfExtent をキーに作り直される)、台帳が指す
    // チャンクidは破棄済みのレンダラーのものなので、丸ごと捨てて載せ直す
    // (旧レンダラーへ removeMeshChunk を呼ぶ必要は無い)。
    if (lastControllerRef.current !== controller) {
      lastControllerRef.current = controller;
      registryRef.current = new MeshChunkRegistry(namespace);
      dirtyRef.current = true;
    }
    const registry = registryRef.current!;
    if (!dirtyRef.current) return;

    if (appliedVersionRef.current !== versionRef.current) {
      for (const id of registry.clear()) controller.removeMeshChunk(id);
      appliedVersionRef.current = versionRef.current;
    }

    const desired = desiredRef.current;
    for (const id of registry.retain(desired)) controller.removeMeshChunk(id);

    let budget = budgetPerFrame;
    let remaining = false;
    for (const key of desired) {
      if (registry.has(key)) continue;
      if (budget <= 0) {
        remaining = true;
        break;
      }
      budget -= 1;
      // 中身が空のチャンク(木が1本も生えないチャンクなど)でも id は確保しておく。
      // そうしないと毎フレーム同じチャンクを作り直そうとしてしまう。
      const id = registry.acquire(key);
      const chunk = buildRef.current(key);
      if (chunk) controller.uploadMeshChunk(id, layerClass, chunk);
    }
    dirtyRef.current = remaining;
  });
}
