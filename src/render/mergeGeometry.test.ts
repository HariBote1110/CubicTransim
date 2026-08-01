import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DIR } from '../utils';
import { mergeAndDispose } from './mergeGeometry';
import { buildBridgeAbutmentPart, buildRampAbutmentPart } from './trackGeometry';

describe('mergeAndDispose: 属性セットが異なるジオメトリの合成', () => {
  it('uv付き(Box)とposition/normalのみの自作ジオメトリを混ぜてもnullにならない', () => {
    const box = new THREE.BoxGeometry(1, 1, 1); // position/normal/uv + index
    const custom = new THREE.BufferGeometry(); // positionのみ → normalを計算(uv無し)
    custom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
    custom.computeVertexNormals();

    const merged = mergeAndDispose([box, custom]);
    expect(merged).not.toBeNull();
    // Boxは非index化で36頂点、三角形1枚は3頂点
    expect(merged!.getAttribute('position').count).toBe(36 + 3);
  });

  it('坂のくさび橋台と直方体の橋台を同じ配列で合成できる(擁壁が全部消える退行の防止)', () => {
    const wedge = buildRampAbutmentPart(DIR.E, 0, 0, 0.5, 0)!;
    const boxAbutment = buildBridgeAbutmentPart(DIR.E, 1, 0, 3.2)!;
    expect(wedge).not.toBeNull();
    expect(boxAbutment).not.toBeNull();

    const merged = mergeAndDispose([wedge, boxAbutment]);
    expect(merged).not.toBeNull();
  });
});
