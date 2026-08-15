// 列車外観エディタ: プレビュー画面上でのパーツピッキング。
// 各インスタンス(head/tail/mid)の各パーツのローカルAABB(partBounds)を、車体のyaw+位置で
// ワールドへ変換し、8頂点を projectToScreenPx(picking.tsが使うのと同じ closed-form 投影)で
// 画面へ射影して、その外接矩形(スクリーン空間AABB)でヒットテストする。
//
// ピッキングルール: カーソルが当たった候補のうち、スクリーン空間AABBの面積が最小のものを選ぶ
// (三国投影では奥のパーツほど手前のパーツに隠れて小さく見えることが多く、重なった場合に
// 「一番手前で、かつ一番的が小さい=クリックが意図されやすい」パーツを拾う簡易近似)。
import { projectToScreenPx, type WebGpuCameraState } from '../../render/webgpuCamera';
import { partBounds, type TrainPart } from '../../render/trainPartsSpec';
import { consistTransforms, type CarVariant } from './consistLayout';

export interface PartPickResult {
  variant: CarVariant;
  role: 'head' | 'tail' | 'mid';
  index: number;
}

/**
 * スクリーン座標(picking.tsのclientToScreenPxと同じ、画面中心原点・物理ピクセル)に当たった
 * パーツを返す。同じ head パーツ配列は head/tail の2インスタンスへ複製されるので、role で
 * どちらに当たったかを区別できる(選択状態としては variant+index で十分)。
 */
export function pickPart(
  camera: WebGpuCameraState,
  sx: number,
  sy: number,
  yawDeg: number,
  headParts: readonly TrainPart[],
  midParts: readonly TrainPart[],
): PartPickResult | null {
  type Candidate = PartPickResult & { area: number };
  let best: Candidate | null = null;

  for (const t of consistTransforms(yawDeg)) {
    const parts = t.variant === 'head' ? headParts : midParts;
    const cos = Math.cos(t.yaw);
    const sin = Math.sin(t.yaw);
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const b = partBounds(part);
      let minSx = Infinity, maxSx = -Infinity, minSy = Infinity, maxSy = -Infinity;
      for (const lx of [b.min[0], b.max[0]]) {
        for (const ly of [b.min[1], b.max[1]]) {
          for (const lz of [b.min[2], b.max[2]]) {
            // mesh_instanced.wgsl の回転規約(pitch=0時): world = R(yaw) * local
            const wx = t.x + lx * cos + lz * sin;
            const wz = t.z - lx * sin + lz * cos;
            const wy = t.y + ly;
            const { sx: psx, sy: psy } = projectToScreenPx({ x: wx, y: wy, z: wz }, camera);
            minSx = Math.min(minSx, psx); maxSx = Math.max(maxSx, psx);
            minSy = Math.min(minSy, psy); maxSy = Math.max(maxSy, psy);
          }
        }
      }
      if (sx >= minSx && sx <= maxSx && sy >= minSy && sy <= maxSy) {
        const area = Math.max(1e-6, (maxSx - minSx) * (maxSy - minSy));
        const candidate: Candidate = { variant: t.variant, role: t.role, index, area };
        if (!best || area < (best as Candidate).area) {
          best = candidate;
        }
      }
    }
  }

  return best ? { variant: best.variant, role: best.role, index: best.index } : null;
}
