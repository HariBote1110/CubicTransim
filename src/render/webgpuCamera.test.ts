import { describe, expect, it } from 'vitest';

import {
  groundCentreFromTarget, pixelsPerWorldUnit, projectToScreenPx, minZoomForFullMap, ISO_X, ISO_Y,
  orthographicNearFarForHalfExtent,
} from './webgpuCamera';

// R4e: three.js を撤去したので、テストのオラクル(検証用の独立実装)として
// three.js の OrthographicCamera.lookAt + Vector3.project と同じ行列演算を素のベクトル計算で
// 再現する(Matrix4.lookAt/makeOrthographicの標準的な右手系の式。GameSceneと同じカメラ配置
// position=target+(20,20,20)・up=+Y・enableRotate=falseを前提にする)。

interface Vec3 { x: number; y: number; z: number }

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const normalise = (v: Vec3): Vec3 => {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
};

interface RefCamera {
  position: Vec3;
  right: Vec3;
  camUp: Vec3;
  backward: Vec3; // three.js のカメラローカル+Z軸(=注視方向の逆)
  zoom: number;
  width: number;
  height: number;
  near: number;
  far: number;
}

// GameScene と同じカメラ設定(OrthographicCamera position=(20,20,20)・up=+Y、
// OrbitControls は enableRotate=false なので target からの相対位置は常に (20,20,20))。
// 基底の導出は render/webgpuCamera.ts 冒頭のコメントと同じ(Z_cam=(1,1,1)/√3等)。
const makeRefCamera = (
  target: Vec3,
  zoom: number,
  width: number,
  height: number,
  near = -50,
  far = 200,
): RefCamera => {
  const position: Vec3 = { x: target.x + 20, y: target.y + 20, z: target.z + 20 };
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  // three.js Matrix4.lookAt(eye, target, up): z = normalize(eye-target), x = normalize(cross(up,z)), y = cross(z,x)
  const backward = normalise(sub(position, target));
  const right = normalise(cross(worldUp, backward));
  const camUp = cross(backward, right);
  return { position, right, camUp, backward, zoom, width, height, near, far };
};

/** 参照カメラで実際に投影し、画面中心を原点とするCSSピクセル座標を返す(sy下向き)。 */
const threeScreenPx = (
  camera: RefCamera,
  world: Vec3,
  width: number,
  height: number,
) => {
  const rel = sub(world, camera.position);
  const xView = dot(rel, camera.right);
  const yView = dot(rel, camera.camUp);
  const xNdc = (2 * camera.zoom * xView) / camera.width;
  const yNdc = (2 * camera.zoom * yView) / camera.height;
  return { sx: (xNdc * width) / 2, sy: (-yNdc * height) / 2 };
};

/** three.js の makeOrthographic + project と同じ z_ndc(視錐台深度の内外判定用)。 */
const projectDepth = (camera: RefCamera, world: Vec3): number => {
  const rel = sub(world, camera.position);
  const zView = dot(rel, camera.backward);
  const { near, far } = camera;
  return (-2 / (far - near)) * zView - (far + near) / (far - near);
};

describe('webgpuCamera: three.js の直交カメラと同じ画面座標を与える', () => {
  const width = 1600;
  const height = 900;

  it('注視点が原点・DPR=1 のとき、任意の点で three.js の投影と一致する', () => {
    const target = { x: 0, y: 0, z: 0 };
    const zoom = 40;
    const camera = makeRefCamera(target, zoom, width, height);
    const state = {
      ...groundCentreFromTarget(target),
      pixelsPerUnit: pixelsPerWorldUnit(zoom, 1),
      widthPx: width,
      heightPx: height,
    };

    for (let i = 0; i < 50; i++) {
      const world = {
        x: ((i * 37) % 61) - 30,
        y: ((i * 13) % 9) * 0.8,
        z: ((i * 23) % 61) - 30,
      };
      const expected = threeScreenPx(camera, world, width, height);
      const actual = projectToScreenPx(world, state);
      expect(actual.sx).toBeCloseTo(expected.sx, 6);
      expect(actual.sy).toBeCloseTo(expected.sy, 6);
    }
  });

  it('パンで target.y がずれても(=OrbitControlsのスクリーン空間パン)一致する', () => {
    const target = { x: 12.5, y: 3.25, z: -8.75 };
    const zoom = 73;
    const camera = makeRefCamera(target, zoom, width, height);
    const state = {
      ...groundCentreFromTarget(target),
      pixelsPerUnit: pixelsPerWorldUnit(zoom, 1),
      widthPx: width,
      heightPx: height,
    };

    for (const world of [
      { x: 0, y: 0, z: 0 },
      { x: 12.5, y: 3.25, z: -8.75 },
      { x: -20, y: 8 * 0.8, z: 31 },
      { x: 44.5, y: 0, z: -44.5 },
    ]) {
      const expected = threeScreenPx(camera, world, width, height);
      const actual = projectToScreenPx(world, state);
      expect(actual.sx).toBeCloseTo(expected.sx, 6);
      expect(actual.sy).toBeCloseTo(expected.sy, 6);
    }
  });

  it('DPR を掛けると物理ピクセル座標がその倍率でスケールする', () => {
    const target = { x: 0, y: 0, z: 0 };
    const zoom = 40;
    const base = {
      ...groundCentreFromTarget(target),
      pixelsPerUnit: pixelsPerWorldUnit(zoom, 1),
      widthPx: width,
      heightPx: height,
    };
    const retina = { ...base, pixelsPerUnit: pixelsPerWorldUnit(zoom, 2) };
    const world = { x: 7, y: 1.6, z: -3 };
    const a = projectToScreenPx(world, base);
    const b = projectToScreenPx(world, retina);
    expect(b.sx).toBeCloseTo(a.sx * 2, 9);
    expect(b.sy).toBeCloseTo(a.sy * 2, 9);
  });

  it('画面中心(地表)は原点に落ちる', () => {
    const target = { x: -5, y: 2, z: 9 };
    const centre = groundCentreFromTarget(target);
    const state = { ...centre, pixelsPerUnit: 80, widthPx: width, heightPx: height };
    const p = projectToScreenPx({ x: centre.centreX, y: 0, z: centre.centreZ }, state);
    expect(p.sx).toBeCloseTo(0, 9);
    expect(p.sy).toBeCloseTo(0, 9);
  });
});

describe('minZoomForFullMap: 全図がビューポートに収まる最小zoomを求める(R3)', () => {
  it('横長ビューポートでは横方向が制約になる(sx幅=4*half*ISO_X*zoom)', () => {
    const halfExtent = 45;
    const width = 1600;
    const height = 900;
    const zoom = minZoomForFullMap(halfExtent, width, height);
    // その zoom でダイヤモンドの外接矩形のどちらかの辺がビューポートにちょうど収まる。
    const mapWidthPx = 4 * halfExtent * ISO_X * zoom;
    const mapHeightPx = 4 * halfExtent * ISO_Y * zoom;
    // 制約が効いている軸(zoomを決めたほう)はぴったり収まり(比=1)、他方の軸は
    // ぴったり以下(比<=1)になる。
    expect(Math.max(mapWidthPx / width, mapHeightPx / height)).toBeCloseTo(1, 9);
    expect(mapWidthPx).toBeLessThanOrEqual(width + 1e-6);
    expect(mapHeightPx).toBeLessThanOrEqual(height + 1e-6);
  });

  it('DPRに依存しない(cssピクセルの幅・高さだけで決まる)', () => {
    const halfExtent = 512;
    const a = minZoomForFullMap(halfExtent, 1280, 800);
    const b = minZoomForFullMap(halfExtent, 1280, 800);
    expect(a).toBe(b);
  });

  it('halfExtentが大きいほどminZoomは小さくなる(より広く引く必要がある)', () => {
    const width = 1280;
    const height = 800;
    const small = minZoomForFullMap(45, width, height);
    const huge = minZoomForFullMap(8192, width, height);
    expect(huge).toBeLessThan(small);
  });

  it('halfExtent<1(縮退マップ)は1として扱う', () => {
    expect(minZoomForFullMap(0, 1000, 1000)).toBeCloseTo(minZoomForFullMap(1, 1000, 1000), 9);
  });

  it('renderer_wgpuのfull_map_min_ppcと同じ式(dprを乗じるとppcの下限に一致する)', () => {
    // lib.rs: full_map_min_ppc(width_px, height_px, half) = min(width_px/(4*half*ISO_X), height_px/(4*half*ISO_Y))
    const halfExtent = 2048;
    const dpr = 2;
    const cssWidth = 1440;
    const cssHeight = 900;
    const zoom = minZoomForFullMap(halfExtent, cssWidth, cssHeight);
    const ppc = pixelsPerWorldUnit(zoom, dpr);
    const widthPx = cssWidth * dpr;
    const heightPx = cssHeight * dpr;
    const expectedPpc = Math.min(widthPx / (4 * halfExtent * ISO_X), heightPx / (4 * halfExtent * ISO_Y));
    expect(ppc).toBeCloseTo(expectedPpc, 9);
  });
});

describe('orthographicNearFarForHalfExtent: マップ全域の点がnear/farでクリップされない(R3)', () => {
  // GameScene.tsxと同じカメラ配置(position=target+(20,20,20)、up=+Y、target注視)。
  const makeCamera = (target: Vec3, near: number, far: number): RefCamera =>
    makeRefCamera(target, 1, 2000, 2000, near, far);

  // three.jsのprojectはNDC z を [-1,1] へ落とす(near/farの外に出るとその範囲を外れる)。
  const isWithinFrustumDepth = (camera: RefCamera, p: Vec3) => {
    const z = projectDepth(camera, p);
    return z >= -1 && z <= 1;
  };

  it('小さいマップ(halfExtent=45)は元の(-50,200)のままでも全域が視錐台に収まる', () => {
    const halfExtent = 45;
    const { near, far } = orthographicNearFarForHalfExtent(halfExtent);
    const camera = makeCamera({ x: 0, y: 0, z: 0 }, near, far);
    const corners = [
      { x: -halfExtent, y: 0, z: -halfExtent },
      { x: halfExtent, y: 0, z: halfExtent },
      { x: -halfExtent, y: 0, z: halfExtent },
      { x: halfExtent, y: 0, z: -halfExtent },
    ];
    for (const p of corners) expect(isWithinFrustumDepth(camera, p)).toBe(true);
  });

  it('16385マップ(halfExtent=8192)で、targetが対角の一方の端にあっても、もう一方の端の町までクリップされない', () => {
    const halfExtent = 8192;
    const { near, far } = orthographicNearFarForHalfExtent(halfExtent);
    // 最悪ケース: targetがマップの隅、点がその対角の隅。
    const target = { x: -halfExtent, y: 0, z: -halfExtent };
    const farCorner = { x: halfExtent, y: 0, z: halfExtent };
    const camera = makeCamera(target, near, far);
    expect(isWithinFrustumDepth(camera, farCorner)).toBe(true);
    // target自身、原点、他の対角隅も収まる。
    expect(isWithinFrustumDepth(camera, target)).toBe(true);
    expect(isWithinFrustumDepth(camera, { x: 0, y: 0, z: 0 })).toBe(true);
    expect(isWithinFrustumDepth(camera, { x: halfExtent, y: 0, z: -halfExtent })).toBe(true);
  });

  it('元のnear/farを広げる方向にしか変えない(marginは非負)', () => {
    const { near, far } = orthographicNearFarForHalfExtent(0, -50, 200);
    expect(near).toBe(-50);
    expect(far).toBe(200);
    const wide = orthographicNearFarForHalfExtent(1000, -50, 200);
    expect(wide.near).toBeLessThanOrEqual(-50);
    expect(wide.far).toBeGreaterThanOrEqual(200);
  });
});
