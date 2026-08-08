import { describe, expect, it } from 'vitest';
import { DIR } from '../utils';
import { BufferGeometry } from './geom';
import { BoxGeometry } from './geom/primitives';
import { mergeAndDispose } from './mergeGeometry';
import { buildBridgeAbutmentPart, buildRampAbutmentPart } from './trackGeometry';

describe('mergeAndDispose: 複数ジオメトリを1つの非indexedジオメトリへ連結する', () => {
  it('複数のジオメトリを混ぜても頂点が欠けない', () => {
    const box = new BoxGeometry(1, 1, 1);
    const custom = new BufferGeometry(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));

    const merged = mergeAndDispose([box, custom]);
    expect(merged).not.toBeNull();
    expect(merged!.getAttribute('position')!.count).toBe(36 + 3);
  });

  it('indexedジオメトリはtoNonIndexedしてから連結する', () => {
    const indexed = new BufferGeometry(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      new Uint32Array([0, 1, 2, 1, 3, 2]),
    );
    const merged = mergeAndDispose([indexed]);
    expect(merged!.index).toBeNull();
    expect(merged!.vertexCount).toBe(6);
  });

  it('坂のくさび橋台と直方体の橋台を同じ配列で合成できる(擁壁が全部消える退行の防止)', () => {
    const wedge = buildRampAbutmentPart(DIR.E, 0, 0, 0.5, 0)!;
    const boxAbutment = buildBridgeAbutmentPart(DIR.E, 1, 0, 3.2)!;
    expect(wedge).not.toBeNull();
    expect(boxAbutment).not.toBeNull();

    const merged = mergeAndDispose([wedge, boxAbutment]);
    expect(merged).not.toBeNull();
    expect(merged!.vertexCount).toBeGreaterThan(0);
  });

  it('空配列にはnullを返す', () => {
    expect(mergeAndDispose([])).toBeNull();
  });
});
