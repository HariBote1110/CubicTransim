// R4a: wgpu のメッシュチャンク id(u32)を、描画側のキー文字列(チャンク座標・町idなど)へ
// 割り当てる小さな台帳。React/THREE には依存しない純粋なロジック。
//
// wasm 側 `uploadMeshChunk(id, ...)` / `removeMeshChunk(id)` は数値idで区別するだけなので、
// 「今どのキーがGPUに載っているか」と「そのidは何番か」をこちらで持つ。フィーダ
// (WebGpuScenery / WebGpuTownBlocks)は可視集合との差分だけをアップロード/削除する。

/**
 * 用途ごとのid名前空間。1つの CanvasRenderer に樹木・町など複数のフィーダが同居するため、
 * 先頭ビットで区間を分けてidの衝突を防ぐ(u32の範囲に収める)。
 */
export const MESH_CHUNK_NAMESPACE = {
  scenery: 0x1000_0000,
  town: 0x2000_0000,
} as const;

export class MeshChunkRegistry {
  private readonly base: number;
  private readonly ids = new Map<string, number>();
  /** release されたidの再利用プール(パンのたびにid空間が単調増加しないようにする)。 */
  private readonly free: number[] = [];
  private next = 0;

  constructor(base: number) {
    this.base = base;
  }

  get size(): number {
    return this.ids.size;
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }

  /** キーに対応するidを返す(未割当なら新規に割り当てる)。 */
  acquire(key: string): number {
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    const id = this.free.pop() ?? this.base + this.next++;
    this.ids.set(key, id);
    return id;
  }

  /** キーを手放し、そのidを返す(未割当なら null)。 */
  release(key: string): number | null {
    const id = this.ids.get(key);
    if (id === undefined) return null;
    this.ids.delete(key);
    this.free.push(id);
    return id;
  }

  /** `desired` に無いキーをすべて手放し、手放したidを返す。 */
  retain(desired: Iterable<string>): number[] {
    const keep = desired instanceof Set ? desired : new Set(desired);
    const removed: number[] = [];
    for (const key of [...this.ids.keys()]) {
      if (!keep.has(key)) {
        const id = this.release(key);
        if (id !== null) removed.push(id);
      }
    }
    return removed;
  }

  /** すべて手放し、手放したidを返す。 */
  clear(): number[] {
    return this.retain([]);
  }
}
