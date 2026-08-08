// R4d: 共有 rAF ループ(render/frameLoop.ts)の simulation フェーズで stepWorld を回す。
// r3f の useFrame を退役させたが、外から見えるデバッグフック
// (__debugWorld / __dbgFrames / __dbgStep)は検証手順が依存しているので互換を保つ。

import React, { useEffect, useRef } from 'react';
import { stepWorld } from '../sim/simulation';
import type { SimWorld, SimEvent } from '../sim/simulation';
import { FRAME_ORDER, frameLoop } from '../render/frameLoop';
import { useFrameLoop } from '../hooks/useFrameLoop';

interface SimulationDriverProps {
  world: React.RefObject<SimWorld>;
  onSimEvent: (event: SimEvent) => void;
  speed: number;
}

export const SimulationDriver: React.FC<SimulationDriverProps> = ({ world, onSimEvent, speed }) => {
  useFrameLoop(FRAME_ORDER.simulation, (delta) => {
    const current = world.current;
    if (!current) return;
    if (speed === 0 || delta <= 0) return;
    const events = stepWorld(current, delta * speed);
    events.forEach(onSimEvent);
    (window as unknown as { __debugWorld?: SimWorld }).__debugWorld = current;
  });

  // 非表示タブでは rAF が止まるため、検証手順(CLAUDE.md)はこのフックで手動 tick する。
  // シミュレーションを n 回進めたあと、フィーダ・カメラ・描画も1フレーム分だけ走らせて
  // 「進めた結果が実際に描かれた状態」をスクリーンショットで確認できるようにする。
  const onSimEventRef = useRef(onSimEvent);
  useEffect(() => {
    onSimEventRef.current = onSimEvent;
  }, [onSimEvent]);

  useEffect(() => {
    const dbg = window as unknown as {
      __dbgStep?: (dt: number, n: number) => void;
      __debugWorld?: SimWorld;
    };
    dbg.__dbgStep = (dt: number, n: number) => {
      const current = world.current;
      if (!current) return;
      for (let i = 0; i < n; i++) {
        const events = stepWorld(current, dt);
        events.forEach(event => onSimEventRef.current(event));
      }
      dbg.__debugWorld = current;
      // delta=0 なので simulation フェーズは何もせず、feed→camera→render だけが走る。
      frameLoop.runFrame(0);
    };
  }, [world]);

  return null;
};
