import React from 'react';
import { useFrame } from '@react-three/fiber';
import { stepWorld } from '../sim/simulation';
import type { SimWorld, SimEvent } from '../sim/simulation';

interface SimulationDriverProps {
  world: React.RefObject<SimWorld>;
  onSimEvent: (event: SimEvent) => void;
}

export const SimulationDriver: React.FC<SimulationDriverProps> = ({ world, onSimEvent }) => {
  useFrame((_state, delta) => {
    const current = world.current;
    if (!current) return;
    const events = stepWorld(current, delta);
    events.forEach(onSimEvent);
    const dbg = window as unknown as { __debugWorld?: SimWorld; __dbgFrames?: number };
    dbg.__debugWorld = current;
    dbg.__dbgFrames = (dbg.__dbgFrames || 0) + 1;
  });

  const dbg = window as unknown as { __dbgStep?: (dt: number, n: number) => void; __debugWorld?: SimWorld };
  dbg.__dbgStep = (dt: number, n: number) => {
    const current = world.current;
    if (!current) return;
    for (let i = 0; i < n; i++) {
      const events = stepWorld(current, dt);
      events.forEach(onSimEvent);
    }
    dbg.__debugWorld = current;
  };

  return null;
};
