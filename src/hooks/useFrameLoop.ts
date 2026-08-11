// R4d: 共有 rAF ループ(render/frameLoop.ts)を React から購読するフック。
// r3f の useFrame をそのまま置き換えるための薄いラッパで、コールバックは ref 経由で
// 最新版を呼ぶ(毎レンダーで購読を張り直さない = 購読順が安定する)。

import { useEffect, useRef } from 'react';
import { frameLoop, type FrameCallback } from '../render/frameLoop';

export function useFrameLoop(order: number, callback: FrameCallback): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => frameLoop.subscribe(order, dt => callbackRef.current(dt)), [order]);
}
