import { useState, useCallback } from 'react';
import { toKey, getDirFromVector, getOppositeDir, DIR } from '../utils';
import type { CellData, CellType, TrainData, StationData } from '../types';

export const useGameLogic = () => {
  const [railMap, setRailMap] = useState<Map<string, CellData>>(new Map());
  const [stations, setStations] = useState<Map<string, StationData>>(new Map());
  const [trains, setTrains] = useState<TrainData[]>([]);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);

  // --- ヘルパー ---
  const updateDepotRotation = (map: Map<string, CellData>, x: number, z: number) => {
    const key = toKey(x, z);
    const cell = map.get(key);
    if (!cell || cell.type !== 'depot') return;

    const neighbors = [
      { dx: 0, dz: -1, dir: DIR.N, rot: 0 },
      { dx: 1, dz: 0, dir: DIR.E, rot: -Math.PI / 2 },
      { dx: 0, dz: 1, dir: DIR.S, rot: Math.PI },
      { dx: -1, dz: 0, dir: DIR.W, rot: Math.PI / 2 },
    ];

    let bestRot = cell.rotation || 0;
    let found = false;

    for (const n of neighbors) {
      const targetKey = toKey(x + n.dx, z + n.dz);
      const targetCell = map.get(targetKey);
      if (targetCell && (targetCell.type === 'rail' || targetCell.type === 'station')) {
        bestRot = n.rot;
        found = true;
        break;
      }
    }
    if (found) {
      map.set(key, { ...cell, rotation: bestRot });
    }
  };

  // --- Commit Path ---
  const commitPath = (path: { x: number; z: number }[], buildMode: CellType | 'none' | 'remove' | 'signal') => {
    if (path.length === 0) return;

    setRailMap(prevMap => {
      const newMap = new Map(prevMap);
      
      // Remove
      if (buildMode === 'remove') {
        path.forEach(pos => {
          const key = toKey(pos.x, pos.z);
          const cell = newMap.get(key);
          if (cell) {
            newMap.delete(key);
            if (cell.type === 'station' && cell.stationId) {
              const sid = cell.stationId;
              setStations(prevS => {
                const newS = new Map(prevS);
                const st = newS.get(sid);
                if (st) {
                  const newCells = st.cells.filter(c => c.x !== pos.x || c.z !== pos.z);
                  if (newCells.length === 0) newS.delete(sid);
                  else {
                    const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
                    const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
                    newS.set(sid, { ...st, cells: newCells, center: { x: cx, z: cz } });
                  }
                }
                return newS;
              });
            }
            const neighbors = [
               { x: pos.x, z: pos.z - 1, dir: DIR.N, opp: DIR.S },
               { x: pos.x + 1, z: pos.z - 1, dir: DIR.NE, opp: DIR.SW },
               { x: pos.x + 1, z: pos.z, dir: DIR.E, opp: DIR.W },
               { x: pos.x + 1, z: pos.z + 1, dir: DIR.SE, opp: DIR.NW },
               { x: pos.x, z: pos.z + 1, dir: DIR.S, opp: DIR.N },
               { x: pos.x - 1, z: pos.z + 1, dir: DIR.SW, opp: DIR.NE },
               { x: pos.x - 1, z: pos.z, dir: DIR.W, opp: DIR.E },
               { x: pos.x - 1, z: pos.z - 1, dir: DIR.NW, opp: DIR.SE },
            ];
            neighbors.forEach(n => {
              const nKey = toKey(n.x, n.z);
              const nCell = newMap.get(nKey);
              if (nCell) {
                if (nCell.connections) {
                  const newConn = nCell.connections & ~n.opp; 
                  newMap.set(nKey, { ...nCell, connections: newConn });
                }
                if (nCell.type === 'depot') updateDepotRotation(newMap, n.x, n.z);
              }
            });
          }
        });
        return newMap;
      }

      // Signal
      if (buildMode === 'signal') {
        const pos = path[0]; 
        const key = toKey(pos.x, pos.z);
        const cell = newMap.get(key);
        if (cell && (cell.type === 'rail' || cell.type === 'station')) {
          const conns = cell.connections || 0;
          if (!cell.signalDir) {
            let firstDir = DIR.N;
            const dirs = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.NE, DIR.SE, DIR.SW, DIR.NW];
            for (const d of dirs) { if (conns & d) { firstDir = d; break; } }
            newMap.set(key, { ...cell, signalDir: firstDir });
          } else {
            let currentDir = cell.signalDir;
            let nextDir = currentDir;
            const dirs = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];
            let idx = dirs.indexOf(currentDir);
            for (let i = 1; i <= 8; i++) {
              const d = dirs[(idx + i) % 8];
              if (conns & d) { nextDir = d; break; }
            }
            newMap.set(key, { ...cell, signalDir: nextDir });
          }
        }
        return newMap;
      }

      // Station
      if (buildMode === 'station') {
        const pos = path[path.length - 1];
        const key = toKey(pos.x, pos.z);
        const neighbors = [{ x: pos.x + 1, z: pos.z }, { x: pos.x - 1, z: pos.z }, { x: pos.x, z: pos.z + 1 }, { x: pos.x, z: pos.z - 1 }];
        let foundStationId: string | null = null;
        for (const n of neighbors) {
          const nKey = toKey(n.x, n.z);
          const cell = newMap.get(nKey);
          if (cell && cell.type === 'station' && cell.stationId) { foundStationId = cell.stationId; break; }
        }
        let targetId = foundStationId;
        if (!targetId) {
          targetId = Math.random().toString(36).substr(2, 9);
          const newName = `Station ${String.fromCharCode(65 + stations.size % 26)}${stations.size >= 26 ? Math.floor(stations.size / 26) + 1 : ''}`;
          setStations(prevS => {
            const newS = new Map(prevS);
            newS.set(targetId!, { id: targetId!, name: newName, cells: [{ x: pos.x, z: pos.z }], center: { x: pos.x, z: pos.z } });
            return newS;
          });
        } else {
          const sid = targetId;
          setStations(prevS => {
            const newS = new Map(prevS);
            const st = newS.get(sid);
            if (st) {
              const newCells = [...st.cells, { x: pos.x, z: pos.z }];
              const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
              const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
              newS.set(sid, { ...st, cells: newCells, center: { x: cx, z: cz } });
            }
            return newS;
          });
        }
        newMap.set(key, { type: 'station', connections: DIR.N | DIR.E | DIR.S | DIR.W, stationId: targetId });
        neighbors.forEach(n => updateDepotRotation(newMap, n.x, n.z));
        return newMap;
      }

      // Depot
      if (buildMode === 'depot') {
        const pos = path[path.length - 1];
        const key = toKey(pos.x, pos.z);
        newMap.set(key, { type: 'depot', connections: DIR.N | DIR.E | DIR.S | DIR.W, rotation: 0 });
        updateDepotRotation(newMap, pos.x, pos.z);
        return newMap;
      }

      // Rail
      for (let i = 0; i < path.length - 1; i++) {
        const curr = path[i];
        const next = path[i+1];
        const currKey = toKey(curr.x, curr.z);
        const nextKey = toKey(next.x, next.z);
        const dx = next.x - curr.x;
        const dz = next.z - curr.z;
        const dir = getDirFromVector(dx, dz);
        const oppDir = getOppositeDir(dir);
        
        const currCell = newMap.get(currKey) || { type: 'rail', connections: 0 };
        if (currCell.type !== 'rail') {
           newMap.set(currKey, { ...currCell, connections: (currCell.connections || 0) | dir });
           if (currCell.type === 'depot') updateDepotRotation(newMap, curr.x, curr.z);
        } else {
           newMap.set(currKey, { type: 'rail', connections: (currCell.connections || 0) | dir });
        }
        const nextCell = newMap.get(nextKey) || { type: 'rail', connections: 0 };
        if (nextCell.type !== 'rail') {
           newMap.set(nextKey, { ...nextCell, connections: (nextCell.connections || 0) | oppDir });
           if (nextCell.type === 'depot') updateDepotRotation(newMap, next.x, next.z);
        } else {
           newMap.set(nextKey, { type: 'rail', connections: (nextCell.connections || 0) | oppDir });
        }
        const checkDepotNeighbors = (px: number, pz: number) => {
           const nbs = [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}];
           nbs.forEach(n => updateDepotRotation(newMap, px+n.x, pz+n.z));
        };
        checkDepotNeighbors(curr.x, curr.z);
        checkDepotNeighbors(next.x, next.z);
      }
      return newMap;
    });
  };

  const removeSignal = (x: number, z: number) => {
     setRailMap(prev => {
       const newMap = new Map(prev);
       const key = toKey(x, z);
       const cell = newMap.get(key);
       if (cell) {
         newMap.set(key, { ...cell, signalDir: undefined });
       }
       return newMap;
     });
  };

  const handleTrainArrive = (trainId: string, currentIndex: number) => {
    setTrains(prev => prev.map(t => {
      if (t.id !== trainId) return t;
      const nextIndex = (currentIndex + 1) % t.schedule.length;
      return { ...t, scheduleIndex: nextIndex };
    }));
  };

  const buyTrain = (x: number, z: number) => {
    const newTrain: TrainData = {
        id: Math.random().toString(36).substr(0, 4),
        x, z,
        schedule: [], scheduleIndex: 0, status: 'stored',
        reservedPath: []
    };
    setTrains(prev => [...prev, newTrain]);
    setSelectedTrainId(newTrain.id);
    setIsEditingSchedule(false);
  };

  // ★修正: 出庫時の安全確認を完全撤廃
  // ボタンを押したら問答無用でRunningにする
  const deployTrain = (trainId: string) => {
    setTrains(prev => prev.map(t => {
      if (t.id === trainId) return { ...t, status: 'running' };
      return t;
    }));
    setSelectedTrainId(trainId);
  };

  const addSchedule = (trainId: string, stationId: string) => {
    if (!isEditingSchedule) return;
    setTrains(prev => prev.map(t => {
        if (t.id === trainId) return { ...t, schedule: [...t.schedule, stationId] };
        return t;
    }));
  };

  const selectTrain = (id: string | null) => {
    setSelectedTrainId(id);
    setIsEditingSchedule(false);
  };

  const updateTrainPath = useCallback((trainId: string, path: { x: number, z: number }[]) => {
    setTrains(prev => {
      const target = prev.find(t => t.id === trainId);
      if (!target) return prev;
      
      if (target.reservedPath && target.reservedPath.length === path.length) {
         if (path.length === 0) return prev;
         if (path[0].x === target.reservedPath[0].x && path[path.length-1].x === target.reservedPath[path.length-1].x) {
             return prev;
         }
      }

      return prev.map(t => {
        if (t.id === trainId) {
          return { ...t, reservedPath: path };
        }
        return t;
      });
    });
  }, []);

  return {
    railMap, setRailMap,
    stations, setStations,
    trains, setTrains,
    selectedTrainId, setSelectedTrainId: selectTrain,
    isEditingSchedule, setIsEditingSchedule,
    commitPath, removeSignal,
    handleTrainArrive, 
    buyTrain, deployTrain, 
    addSchedule,
    updateTrainPath
  };
};