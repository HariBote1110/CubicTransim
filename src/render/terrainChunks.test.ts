import { describe, it, expect } from 'vitest';
import {
  TERRAIN_CHUNK_SIZE, chunkCoordOf, chunkKey, mapChunkBounds, visibleChunkRange,
  chunkCellBounds, chunkCells,
} from './terrainChunks';

describe('chunkCoordOf', () => {
  it('セル座標をチャンクサイズで床除算する', () => {
    expect(chunkCoordOf(0)).toBe(0);
    expect(chunkCoordOf(31)).toBe(0);
    expect(chunkCoordOf(32)).toBe(1);
    expect(chunkCoordOf(-1)).toBe(-1);
    expect(chunkCoordOf(-32)).toBe(-1);
    expect(chunkCoordOf(-33)).toBe(-2);
  });
});

describe('chunkKey', () => {
  it('cx,czの組を一意な文字列にする', () => {
    expect(chunkKey(1, -2)).toBe('1,-2');
    expect(chunkKey(1, -2)).not.toBe(chunkKey(-1, 2));
  });
});

describe('mapChunkBounds', () => {
  it('halfExtentからチャンク範囲を導く(通常の91x91相当)', () => {
    const bounds = mapChunkBounds(45);
    expect(bounds).toEqual({
      cx0: chunkCoordOf(-45),
      cx1: chunkCoordOf(45),
      cz0: chunkCoordOf(-45),
      cz1: chunkCoordOf(45),
    });
    // -45..45 は 91セル。TERRAIN_CHUNK_SIZE=32なので(-45は-2、45は+1チャンクに属し)4チャンクにまたがる。
    expect(bounds.cx1 - bounds.cx0 + 1).toBe(4);
  });

  it('縮退マップ(halfExtent=0)でも1チャンクを返す', () => {
    const bounds = mapChunkBounds(0);
    expect(bounds).toEqual({ cx0: 0, cx1: 0, cz0: 0, cz1: 0 });
  });

  it('負のhalfExtentも0扱いで1チャンクを返す', () => {
    const bounds = mapChunkBounds(-5);
    expect(bounds).toEqual({ cx0: 0, cx1: 0, cz0: 0, cz1: 0 });
  });

  it('16Kマップ級(halfExtent=8192)でも境界だけを計算しO(1)', () => {
    const bounds = mapChunkBounds(8192);
    expect(bounds.cx0).toBe(chunkCoordOf(-8192));
    expect(bounds.cx1).toBe(chunkCoordOf(8192));
  });
});

describe('visibleChunkRange', () => {
  it('注視点まわりの可視半径をチャンクへ変換し、margin分だけ広げる', () => {
    const chunks = visibleChunkRange({ x: 0, z: 0 }, 10, 45, 1);
    // 注視点0、半径10なので生セル範囲は-10..10(チャンク0のみ)。margin=1で外側1チャンク分広げる
    // ため、-1..1のチャンクが出るはず。
    const cxs = new Set(chunks.map(c => c.cx));
    const czs = new Set(chunks.map(c => c.cz));
    // 可視セル範囲は-10..10。chunkCoordOf(-10)=-1、chunkCoordOf(10)=0で、
    // margin=1をさらに外側へ広げるため-2..1の4チャンク幅になる。
    expect(cxs).toEqual(new Set([-2, -1, 0, 1]));
    expect(czs).toEqual(new Set([-2, -1, 0, 1]));
    expect(chunks.length).toBe(16);
  });

  it('margin=0なら可視半径ぴったりのチャンクだけを返す(負側のセルはチャンク-1に属する)', () => {
    const chunks = visibleChunkRange({ x: 0, z: 0 }, 5, 45, 0);
    // 可視セル範囲は-5..5。chunkCoordOf(-5)=-1、chunkCoordOf(5)=0なので、
    // margin無しでも(-1,0)×(-1,0)の4チャンクにまたがる。
    expect(chunks).toEqual([
      { cx: -1, cz: -1 }, { cx: -1, cz: 0 }, { cx: 0, cz: -1 }, { cx: 0, cz: 0 },
    ]);
  });

  it('margin=0かつ可視半径が1チャンク内に収まれば単一チャンクを返す', () => {
    const chunks = visibleChunkRange({ x: 10, z: 10 }, 5, 45, 0);
    expect(chunks).toEqual([{ cx: 0, cz: 0 }]);
  });

  it('マップ範囲外を向いていてもmapChunkBoundsへクランプされる', () => {
    const chunks = visibleChunkRange({ x: 10000, z: 10000 }, 5, 45, 1);
    const bounds = mapChunkBounds(45);
    for (const c of chunks) {
      expect(c.cx).toBeLessThanOrEqual(bounds.cx1);
      expect(c.cz).toBeLessThanOrEqual(bounds.cz1);
    }
    // 注視点がマップの右下はるか外なので、返るのはマップの最も右下寄りのチャンクのみ。
    expect(chunks).toEqual([{ cx: bounds.cx1, cz: bounds.cz1 }]);
  });

  it('注視点がマップ左上はるか外でもクランプされ空にならない', () => {
    const chunks = visibleChunkRange({ x: -10000, z: -10000 }, 5, 45, 1);
    const bounds = mapChunkBounds(45);
    expect(chunks).toEqual([{ cx: bounds.cx0, cz: bounds.cz0 }]);
  });

  it('縮退マップ(halfExtent=0)では常に単一チャンクを返す', () => {
    const chunks = visibleChunkRange({ x: 0, z: 0 }, 100, 0, 1);
    expect(chunks).toEqual([{ cx: 0, cz: 0 }]);
  });

  it('16K相当のhalfExtentでも可視チャンク数は半径・marginだけで決まる(マップサイズ非依存)', () => {
    const chunksSmallMap = visibleChunkRange({ x: 0, z: 0 }, 20, 45, 1);
    const chunksHugeMap = visibleChunkRange({ x: 0, z: 0 }, 20, 8192, 1);
    expect(chunksHugeMap.length).toBe(chunksSmallMap.length);
  });

  it('決定的な順序(cx昇順→cz昇順)で返す', () => {
    const chunks = visibleChunkRange({ x: 0, z: 0 }, 40, 45, 0);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const cur = chunks[i];
      expect(cur.cx > prev.cx || (cur.cx === prev.cx && cur.cz > prev.cz)).toBe(true);
    }
  });
});

describe('chunkCellBounds', () => {
  it('チャンク内部にすべて収まる場合はTERRAIN_CHUNK_SIZE四方', () => {
    const bounds = chunkCellBounds({ cx: 0, cz: 0 }, 100);
    expect(bounds).toEqual({ x0: 0, x1: TERRAIN_CHUNK_SIZE - 1, z0: 0, z1: TERRAIN_CHUNK_SIZE - 1 });
  });

  it('マップ境界にかかるチャンクはクランプされる', () => {
    // halfExtent=45なので、セル範囲は-45..45。cx=1は32..63だが63は範囲外→45まで。
    const bounds = chunkCellBounds({ cx: 1, cz: 0 }, 45);
    expect(bounds).toEqual({ x0: 32, x1: 45, z0: 0, z1: TERRAIN_CHUNK_SIZE - 1 });
  });

  it('マップ範囲外のチャンクはnull', () => {
    const bounds = chunkCellBounds({ cx: 10, cz: 0 }, 45);
    expect(bounds).toBeNull();
  });
});

describe('chunkCells', () => {
  it('チャンク内の全セルをx昇順→z昇順で列挙する', () => {
    const cells = Array.from(chunkCells({ cx: 0, cz: 0 }, 3));
    // halfExtent=3なので0..3のセルのみ(4x4=16セル)。
    expect(cells.length).toBe(16);
    expect(cells[0]).toEqual({ x: 0, z: 0 });
    expect(cells[cells.length - 1]).toEqual({ x: 3, z: 3 });
  });

  it('マップ範囲外のチャンクは空を返す', () => {
    const cells = Array.from(chunkCells({ cx: 10, cz: 10 }, 3));
    expect(cells).toEqual([]);
  });

  it('全チャンクを合算すると全域スキャンと同じセル集合になる', () => {
    const halfExtent = 45;
    const bounds = mapChunkBounds(halfExtent);
    const collected = new Set<string>();
    for (let cx = bounds.cx0; cx <= bounds.cx1; cx++) {
      for (let cz = bounds.cz0; cz <= bounds.cz1; cz++) {
        for (const cell of chunkCells({ cx, cz }, halfExtent)) {
          collected.add(`${cell.x},${cell.z}`);
        }
      }
    }
    const expected = new Set<string>();
    for (let x = -halfExtent; x <= halfExtent; x++) {
      for (let z = -halfExtent; z <= halfExtent; z++) {
        expected.add(`${x},${z}`);
      }
    }
    expect(collected).toEqual(expected);
  });
});
