#!/usr/bin/env node
// R5: Stormworks 製 ASCII PLY(E233系ボクセルモデル)を列車 glb へ変換する CLI。
// progress/ply-train-import.md 参照。
//
// 使い方:
//   node renderer/tools/ply_to_train_glb.mjs \
//     --kuha "Stormworks_train_model/E233 0 KUHA.ply" \
//     --moha "Stormworks_train_model/E233 0 MOHA.ply" \
//     --out public/models/trains/e233.glb \
//     [--voxel 1.0] [--flip] [--body-width 0.44] [--max-tris 500]
//
// KUHA(先頭車)→ car_head、MOHA(中間車)→ car_mid。SAHA は今回未使用(将来 car_tail 用に流用可)。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  parsePly, voxelizeFaces, downsampleVoxels, greedyMeshVoxels, transformTriangles, buildTrainGlbBuffer,
} from './plyMeshLib.mjs';
import { validateTrainGlb } from './validate_train_glb.mjs';

const NATIVE_CELL_SIZE = 0.25; // Stormworksのボクセルグリッド
const TARGET_LENGTH = 0.86; // progress/train-model-format.md 推奨値
const DEFAULT_BODY_WIDTH = 0.44; // src/render/trainPartsSpec.ts の車両幅に合わせたデフォルメ目標
const HEIGHT_LIMIT = 0.60; // src/render/trainPartsSpec.ts の HEIGHT_LIMIT

function parseArgs(argv) {
  const args = {
    kuha: 'Stormworks_train_model/E233 0 KUHA.ply',
    moha: 'Stormworks_train_model/E233 0 MOHA.ply',
    out: 'public/models/trains/e233.glb',
    voxel: 1.25,
    flip: false,
    bodyWidth: DEFAULT_BODY_WIDTH,
    maxTris: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kuha') args.kuha = argv[++i];
    else if (a === '--moha') args.moha = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--voxel') args.voxel = Number(argv[++i]);
    else if (a === '--flip') args.flip = true;
    else if (a === '--body-width') args.bodyWidth = Number(argv[++i]);
    else if (a === '--max-tris') args.maxTris = Number(argv[++i]);
  }
  return args;
}

/** 1車ぶんのPLYファイルを三角形スープ(未変換・実寸)へ変換する。 */
function plyFileToRawTriangles(path, voxelSize) {
  const text = readFileSync(path, 'utf8');
  const ply = parsePly(text);
  const nativeVoxels = voxelizeFaces(ply, NATIVE_CELL_SIZE);
  const factor = Math.max(1, Math.round(voxelSize / NATIVE_CELL_SIZE));
  const voxels = downsampleVoxels(nativeVoxels, factor);
  const cellSize = NATIVE_CELL_SIZE * factor;
  const triangles = greedyMeshVoxels(voxels, cellSize);
  return { triangles, nativeVoxelCount: nativeVoxels.size, voxelCount: voxels.size };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`voxel=${args.voxel} flip=${args.flip}`);

  const kuha = plyFileToRawTriangles(args.kuha, args.voxel);
  const moha = plyFileToRawTriangles(args.moha, args.voxel);
  console.log(`KUHA: 実グリッドボクセル=${kuha.nativeVoxelCount} 間引き後=${kuha.voxelCount} 面メッシュ三角形=${kuha.triangles.length}`);
  console.log(`MOHA: 実グリッドボクセル=${moha.nativeVoxelCount} 間引き後=${moha.voxelCount} 面メッシュ三角形=${moha.triangles.length}`);

  // 先頭車(KUHA)の全長を基準スケール(Z)とし、中間車にも同じZスケールを適用する(編成内の相対的な全長比を保つ)。
  // X/Y(断面)は bodyWidth/heightLimit にフィットする非一様スケールを各車それぞれで求める
  // (実寸のリアルな縮尺は細すぎてこのゲームのデフォルメ体型に合わないため)。
  const headTransform = transformTriangles(kuha.triangles, {
    targetLength: TARGET_LENGTH, flip: args.flip, bodyWidth: args.bodyWidth, heightLimit: HEIGHT_LIMIT,
  });
  const midTransform = transformTriangles(moha.triangles, {
    targetLength: TARGET_LENGTH, scale: headTransform.scale, flip: args.flip, bodyWidth: args.bodyWidth, heightLimit: HEIGHT_LIMIT,
  });

  console.log(`car_head 三角形数=${headTransform.triangles.length} aabb=${headTransform.aabb.map((v) => v.toFixed(3)).join(',')}`);
  console.log(`car_mid  三角形数=${midTransform.triangles.length} aabb=${midTransform.aabb.map((v) => v.toFixed(3)).join(',')}`);

  const buffer = buildTrainGlbBuffer([
    { name: 'car_head', triangles: headTransform.triangles },
    { name: 'car_mid', triangles: midTransform.triangles },
  ]);

  const { ok, checks } = validateTrainGlb(buffer, args.maxTris !== undefined ? { maxTris: args.maxTris } : {});
  console.log('\n--- validate_train_glb ---');
  for (const check of checks) {
    console.log(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name} — ${check.detail}`);
  }
  console.log(ok ? '総合判定: PASS' : '総合判定: FAIL');

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, buffer);
  console.log(`\n書き出し: ${args.out} (${(buffer.length / 1024).toFixed(1)} KB)`);

  if (!ok) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
