import { describe, it, expect } from 'vitest';
import { MeshChunkRegistry, MESH_CHUNK_NAMESPACE } from './meshChunkRegistry';

describe('MeshChunkRegistry', () => {
  it('同じキーには同じidを返し、別のキーには別のidを割り当てる', () => {
    const registry = new MeshChunkRegistry(MESH_CHUNK_NAMESPACE.scenery);
    const a = registry.acquire('0,0');
    expect(registry.acquire('0,0')).toBe(a);
    expect(registry.acquire('1,0')).not.toBe(a);
    expect(registry.size).toBe(2);
  });

  it('名前空間ごとにidが重ならない(樹木と町が同じレンダラーへ同居する)', () => {
    const scenery = new MeshChunkRegistry(MESH_CHUNK_NAMESPACE.scenery);
    const town = new MeshChunkRegistry(MESH_CHUNK_NAMESPACE.town);
    expect(scenery.acquire('0,0')).not.toBe(town.acquire('0,0'));
  });

  it('releaseでidを手放し、次のacquireで再利用する(id空間を膨らませない)', () => {
    const registry = new MeshChunkRegistry(MESH_CHUNK_NAMESPACE.scenery);
    const a = registry.acquire('0,0');
    expect(registry.release('0,0')).toBe(a);
    expect(registry.release('0,0')).toBeNull();
    expect(registry.size).toBe(0);
    expect(registry.acquire('9,9')).toBe(a);
  });

  it('retainは可視集合に無いキーだけを手放し、そのidを返す', () => {
    const registry = new MeshChunkRegistry(MESH_CHUNK_NAMESPACE.scenery);
    const keep = registry.acquire('0,0');
    const drop = registry.acquire('5,5');
    const removed = registry.retain(['0,0', '7,7']);
    expect(removed).toEqual([drop]);
    expect(registry.has('0,0')).toBe(true);
    expect(registry.has('5,5')).toBe(false);
    // 保持したキーのidは変わらない(再アップロードを誘発しない)。
    expect(registry.acquire('0,0')).toBe(keep);
  });

  it('clearは全idを返して空になる', () => {
    const registry = new MeshChunkRegistry(MESH_CHUNK_NAMESPACE.scenery);
    const ids = [registry.acquire('a'), registry.acquire('b')];
    expect(registry.clear().sort()).toEqual(ids.sort());
    expect(registry.size).toBe(0);
  });
});
