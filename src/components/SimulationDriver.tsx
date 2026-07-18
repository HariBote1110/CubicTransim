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
  });

  return null;
};
