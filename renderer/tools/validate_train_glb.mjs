#!/usr/bin/env node
// R4c: 列車モデル(.glb)の自己検査ツール。progress/train-model-format.md 準拠。
//
// 使い方: node renderer/tools/validate_train_glb.mjs public/models/trains/<車種id>.glb
//
// 依存なし(vendored glTFパーサ glbLib.mjs のみ)。検査項目:
//   - glTF 2.0 バイナリとして解析可能
//   - 必須ノード(car_head, car_mid)の存在
//   - 三角形数上限(本体<=500、lod1<=80)
//   - バウンディングボックス(全長Z<=0.92 / 全幅X<=0.50 / 全高Y<=0.60)
//   - y<0 のジオメトリが無い(フランジ含めレール上面より下に出ない)
//   - テクスチャ・スキン・アニメーション・モーフを使わない

import { readFileSync } from 'node:fs';
import { collectNodeGeometry, findRootNodeByName, parseGlb } from './glbLib.mjs';

export const DIMENSION_LIMITS = { length: 0.92, width: 0.50, height: 0.60 };
export const TRIANGLE_BUDGET = { full: 500, lod1: 80 };
export const REQUIRED_NODES = ['car_head', 'car_mid'];
export const OPTIONAL_LOD1_NODES = ['car_head_lod1', 'car_mid_lod1', 'car_tail_lod1'];
export const Y_TOLERANCE = 1e-4;

/**
 * @param {Buffer|Uint8Array} bytes
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[] }}
 */
export function validateTrainGlb(bytes) {
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok, detail });

  let json, bin;
  try {
    ({ json, bin } = parseGlb(bytes));
    record('glTF 2.0 として解析可能', true, `asset.version=${json.asset?.version ?? '?'}`);
  } catch (error) {
    record('glTF 2.0 として解析可能', false, error.message);
    return { ok: false, checks };
  }

  if (json.asset?.version !== '2.0') {
    record('asset.version が2.0', false, `実際: ${json.asset?.version}`);
  } else {
    record('asset.version が2.0', true, '2.0');
  }

  // 必須ノードの存在確認
  const nodeIndices = {};
  for (const name of REQUIRED_NODES) {
    const index = findRootNodeByName(json, name);
    nodeIndices[name] = index;
    record(`必須ノード ${name} が存在する`, index !== null, index !== null ? `node[${index}]` : '見つかりません');
  }

  // テクスチャ・スキン・アニメーション不使用
  const hasTextures = (json.textures?.length ?? 0) > 0 || (json.images?.length ?? 0) > 0;
  record('テクスチャ・画像を使わない', !hasTextures, hasTextures ? `textures=${json.textures?.length ?? 0} images=${json.images?.length ?? 0}` : 'なし');
  const hasSkins = (json.skins?.length ?? 0) > 0;
  record('スキンを使わない', !hasSkins, hasSkins ? `skins=${json.skins.length}` : 'なし');
  const hasAnimations = (json.animations?.length ?? 0) > 0;
  record('アニメーションを使わない', !hasAnimations, hasAnimations ? `animations=${json.animations.length}` : 'なし');

  // ノードごとの三角形数・AABB・モーフ使用
  const carNames = [...REQUIRED_NODES, 'car_tail', ...OPTIONAL_LOD1_NODES];
  for (const name of carNames) {
    const index = findRootNodeByName(json, name);
    if (index === null) continue; // 任意ノードは無くてもよい(必須ノードは上でチェック済み)

    const geometry = collectNodeGeometry(json, bin, index);
    const isLod1 = name.endsWith('_lod1');
    const budget = isLod1 ? TRIANGLE_BUDGET.lod1 : TRIANGLE_BUDGET.full;
    record(
      `${name}: 三角形数 <= ${budget}`,
      geometry.triangleCount <= budget,
      `${geometry.triangleCount}三角形`,
    );
    record(`${name}: モーフターゲットを使わない`, !geometry.hasSkinOrMorph, geometry.hasSkinOrMorph ? '使用あり' : 'なし');

    if (geometry.hasGeometry) {
      const [minX, minY, minZ, maxX, maxY, maxZ] = geometry.aabb;
      const width = maxX - minX;
      const height = maxY - minY;
      const length = maxZ - minZ;
      if (!isLod1) {
        record(`${name}: 全幅(X) <= ${DIMENSION_LIMITS.width}`, width <= DIMENSION_LIMITS.width, `${width.toFixed(4)}`);
        record(`${name}: 全高(Y) <= ${DIMENSION_LIMITS.height}`, height <= DIMENSION_LIMITS.height, `${height.toFixed(4)}`);
        record(`${name}: 全長(Z) <= ${DIMENSION_LIMITS.length}`, length <= DIMENSION_LIMITS.length, `${length.toFixed(4)}`);
      }
      record(`${name}: y<0 のジオメトリが無い`, minY >= -Y_TOLERANCE, `minY=${minY.toFixed(4)}`);
    } else {
      record(`${name}: ジオメトリを持つ`, false, 'POSITION属性を持つプリミティブが見つかりません');
    }
  }

  const ok = checks.every(c => c.ok);
  return { ok, checks };
}

function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('使い方: node renderer/tools/validate_train_glb.mjs <path/to/model.glb>');
    process.exit(2);
  }
  const bytes = readFileSync(filePath);
  const { ok, checks } = validateTrainGlb(bytes);
  console.log(`検査対象: ${filePath}`);
  for (const check of checks) {
    console.log(`  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name} — ${check.detail}`);
  }
  console.log(ok ? '\n総合判定: PASS' : '\n総合判定: FAIL');
  process.exit(ok ? 0 : 1);
}

// ESM: このファイルが直接実行された場合だけmain()を走らせる(テストからのimportでは走らせない)。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
