import * as THREE from 'three';
import { PALETTE } from './palette';

const SIZE = 256;
// 1タイルあたりのテクスチャ繰り返し数の逆数。値が大きいほど模様が大きくなる。
const TILES_PER_REPEAT = 12;

// 決定的な擬似乱数(見た目が毎回変わらないように固定シードで回す)。
const rng = (() => {
  let s = 0x2f6e2b1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
})();

/**
 * 草地の色ムラを描いたタイリングテクスチャを生成する。
 *
 * 単色の巨大な平面はどうしても「板」に見えるため、明暗2色のぼかしブロブを
 * 敷き詰めて草地らしい不均一さを出す。画像アセットを増やしたくないので
 * Canvasで生成し、繰り返し(RepeatWrapping)で全面に貼る。
 */
export function createGroundTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = PALETTE.ground;
  ctx.fillRect(0, 0, SIZE, SIZE);

  const blobs: [string, number, number][] = [
    [PALETTE.grassLight, 90, 26],
    [PALETTE.grassDark, 110, 22],
  ];

  for (const [colour, count, maxR] of blobs) {
    ctx.fillStyle = colour;
    for (let i = 0; i < count; i++) {
      const x = rng() * SIZE;
      const y = rng() * SIZE;
      const r = 8 + rng() * maxR;
      ctx.globalAlpha = 0.1 + rng() * 0.22;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * (0.6 + rng() * 0.8), rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
      // タイル境界の継ぎ目を消すため、はみ出したぶんを反対側にも描く
      for (const [ox, oy] of [[SIZE, 0], [-SIZE, 0], [0, SIZE], [0, -SIZE]] as const) {
        ctx.beginPath();
        ctx.ellipse(x + ox, y + oy, r, r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(140 / TILES_PER_REPEAT, 140 / TILES_PER_REPEAT);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
