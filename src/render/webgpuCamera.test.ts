import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  groundCentreFromTarget, pixelsPerWorldUnit, projectToScreenPx,
} from './webgpuCamera';

// GameScene と同じカメラ設定(OrthographicCamera position=(20,20,20)・up=+Y、
// OrbitControls は enableRotate=false なので target からの相対位置は常に (20,20,20))。
const makeThreeCamera = (
  target: { x: number; y: number; z: number },
  zoom: number,
  width: number,
  height: number,
) => {
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, -50, 200);
  camera.zoom = zoom;
  camera.position.set(target.x + 20, target.y + 20, target.z + 20);
  camera.lookAt(target.x, target.y, target.z);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return camera;
};

/** three.js のカメラで実際に投影し、画面中心を原点とするCSSピクセル座標を返す(sy下向き)。 */
const threeScreenPx = (
  camera: THREE.OrthographicCamera,
  world: { x: number; y: number; z: number },
  width: number,
  height: number,
) => {
  const ndc = new THREE.Vector3(world.x, world.y, world.z).project(camera);
  return { sx: (ndc.x * width) / 2, sy: (-ndc.y * height) / 2 };
};

describe('webgpuCamera: three.js の直交カメラと同じ画面座標を与える', () => {
  const width = 1600;
  const height = 900;

  it('注視点が原点・DPR=1 のとき、任意の点で three.js の投影と一致する', () => {
    const target = { x: 0, y: 0, z: 0 };
    const zoom = 40;
    const camera = makeThreeCamera(target, zoom, width, height);
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
    const camera = makeThreeCamera(target, zoom, width, height);
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
