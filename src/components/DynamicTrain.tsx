import React, { useState, useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { TRAIN_COLOUR, SELECTED_TRAIN_COLOUR } from '../types';
import type { TrainType, CellData, TrainData, StationData } from '../types';
import { toKey, DIR, getVectorFromDir } from '../utils';

const STOP_DURATION = 3000;
const TRAIN_LENGTH_TILES = 2; 

const TILE_LENGTH = 30; 
const MAX_SPEED_KMH = 100.0; 
const MIN_CRAWL_SPEED_KMH = 5.0; 
const ACCEL_KMH_S = 15.0; 
const DECEL_KMH_S = 20.0; 

interface DynamicTrainProps {
  data: TrainData;
  type: TrainType;
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
  allTrains: TrainData[];
  isSelected: boolean;
  onArriveStation: (trainId: string, stationIndex: number) => void;
  onClick: (e: any) => void;
  onUpdatePath: (trainId: string, path: { x: number, z: number }[]) => void;
  onUpdateOccupancy: (trainId: string, x: number, z: number, occupied: { x: number, z: number }[]) => void;
}

export const DynamicTrain: React.FC<DynamicTrainProps> = ({ 
  data, type, railMap, stations, allTrains, isSelected, onArriveStation, onClick, onUpdatePath, onUpdateOccupancy
}) => {
  const groupRef = useRef<THREE.Group>(null);
  
  const [currentGrid, setCurrentGrid] = useState({ x: data.x, z: data.z });
  const [prevGrid, setPrevGrid] = useState<{ x: number; z: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [isStopped, setIsStopped] = useState(false);
  const [isWaiting] = useState(false);

  const [localRoute, setLocalRoute] = useState<{ x: number; z: number }[]>([]);
  const [trail, setTrail] = useState<{ x: number, z: number }[]>([{ x: data.x, z: data.z }]);
  const [debugStatus, setDebugStatus] = useState<string>("");
  const [waitTimer, setWaitTimer] = useState(0);

  const speedRef = useRef(0); 

  const targetStationId = data.schedule.length > 0 ? data.schedule[data.scheduleIndex] : null;

  // --- 経路探索 (BFS) ---
  const calculateRoute = (start: { x: number, z: number }, targetId: string) => {
    const targetSt = stations.get(targetId);
    if (!targetSt) return [];

    const reservedMap = new Set<string>();
    const occupiedMap = new Set<string>();

    allTrains.forEach(t => {
      if (t.id === data.id) return;
      if (t.occupiedCells) {
        t.occupiedCells.forEach(c => occupiedMap.add(toKey(c.x, c.z)));
      } else {
        occupiedMap.add(toKey(t.x, t.z));
      }
      if (t.status === 'running' && t.reservedPath) {
        t.reservedPath.forEach(p => reservedMap.add(toKey(p.x, p.z)));
      }
    });

    const runSearch = (ignoreOccupied: boolean) => {
        const queue = [{ curr: start, path: [] as { x: number; z: number }[], prev: prevGrid }];
        const visited = new Set<string>();
        visited.add(toKey(start.x, start.z));
        const MAX_DEPTH = 300;

        while (queue.length > 0) {
            const { curr, path, prev } = queue.shift()!;
            const currKey = toKey(curr.x, curr.z);
            const cell = railMap.get(currKey);

            if (cell && cell.stationId === targetId) return path;
            if (path.length >= MAX_DEPTH) continue;

            const myConnections = cell?.connections || 0;
            const directions = [
                { x: 0, z: -1, dir: DIR.N }, { x: 1, z: -1, dir: DIR.NE },
                { x: 1, z: 0, dir: DIR.E }, { x: 1, z: 1, dir: DIR.SE },
                { x: 0, z: 1, dir: DIR.S }, { x: -1, z: 1, dir: DIR.SW },
                { x: -1, z: 0, dir: DIR.W }, { x: -1, z: -1, dir: DIR.NW }
            ];

            const validMoves = [];
            for (const d of directions) {
                if ((myConnections & d.dir) === 0) continue;
                const tx = curr.x + d.x;
                const tz = curr.z + d.z;
                if (prev && tx === prev.x && tz === prev.z) continue;

                if (prev) {
                    const cv = new THREE.Vector3(curr.x - prev.x, 0, curr.z - prev.z).normalize();
                    const nv = new THREE.Vector3(d.x, 0, d.z).normalize();
                    if (cv.dot(nv) < 0.5) continue;
                }

                const targetKey = toKey(tx, tz);
                const targetCell = railMap.get(targetKey);
                if (targetCell && targetCell.signalDir) {
                    const sv = getVectorFromDir(targetCell.signalDir);
                    const dv = { x: d.x, z: d.z };
                    if ((sv.x * dv.x + sv.z * dv.z) < -0.1) continue;
                }

                if (!ignoreOccupied) {
                    if (reservedMap.has(targetKey)) continue;
                    if (occupiedMap.has(targetKey)) continue;
                }

                validMoves.push({ x: tx, z: tz });
            }

            if (validMoves.length === 0 && prev) {
                 queue.push({ curr: prev, path: [...path, prev], prev: curr });
            }

            for (const move of validMoves) {
                const key = toKey(move.x, move.z);
                if (!visited.has(key)) {
                    visited.add(key);
                    queue.push({ curr: move, path: [...path, move], prev: curr });
                }
            }
        }
        return null;
    };

    const smartPath = runSearch(false);
    if (smartPath) return smartPath;
    const fallbackPath = runSearch(true);
    return fallbackPath || [];
  };

  useEffect(() => {
    if (data.status === 'running' && targetStationId) {
      if (localRoute.length === 0 && !isStopped) {
        const newPath = calculateRoute(currentGrid, targetStationId);
        if (newPath.length > 0) {
          setLocalRoute(newPath);
          onUpdatePath(data.id, newPath);
          setDebugStatus("Route Found");
        } else {
          setDebugStatus("No Path (Retrying...)");
        }
      }
    }
  }, [data.status, targetStationId, currentGrid, isStopped, localRoute.length]); 

  useEffect(() => {
      onUpdateOccupancy(data.id, currentGrid.x, currentGrid.z, trail);
  }, [currentGrid, trail, onUpdateOccupancy, data.id]);


  useFrame((_state, delta) => {
    if (data.status !== 'running') {
        speedRef.current = 0;
        if (debugStatus !== "Stored") setDebugStatus("Stored");
        return;
    }
    if (isStopped || !groupRef.current) {
        speedRef.current = 0;
        if (isStopped && debugStatus !== "Stopped at Station") setDebugStatus("Stopped at Station");
        return;
    }
    
    if (localRoute.length === 0) {
        speedRef.current = Math.max(0, speedRef.current - DECEL_KMH_S * delta);
        setDebugStatus("Waiting for Path...");
        onUpdatePath(data.id, []);
        setWaitTimer(prev => prev + delta);
        if (waitTimer > 1.0) {
             const newPath = calculateRoute(currentGrid, targetStationId!);
             if (newPath.length > 0) setLocalRoute(newPath);
             setWaitTimer(0);
        }
        return;
    }

    const nextTile = localRoute[0];
    let immediateBlock = false;
    let limitDistance = 9999; 
    let obstacleType: 'station' | 'signal' | 'train' | 'none' = 'none';

    // --- 1. 直前マスの物理的占有 (緊急ブレーキ) ---
    const physicalBlocker = allTrains.find(t => {
      if (t.id === data.id) return false;
      const cells = t.occupiedCells || [{ x: t.x, z: t.z }];
      return cells.some(c => Math.round(c.x) === nextTile.x && Math.round(c.z) === nextTile.z);
    });
    if (physicalBlocker) {
        immediateBlock = true;
        setDebugStatus(`Blocked by Train ${physicalBlocker.id}`);
        limitDistance = 0;
        obstacleType = 'train';
    }

    // --- 2. 前方の障害物までの距離計算 ---
    if (!immediateBlock) {
        let distAccumulator = 0;
        const currentTileGeoDist = Math.sqrt(Math.pow(nextTile.x - currentGrid.x, 2) + Math.pow(nextTile.z - currentGrid.z, 2));
        distAccumulator += (1.0 - progress) * (currentTileGeoDist * TILE_LENGTH);

        let foundObstacle = false;
        
        for (let i = 0; i < localRoute.length; i++) {
            const p = localRoute[i];
            
            if (i > 0) {
                 const prevP = localRoute[i-1];
                 const dGeo = Math.sqrt(Math.pow(p.x - prevP.x, 2) + Math.pow(p.z - prevP.z, 2));
                 distAccumulator += dGeo * TILE_LENGTH;
            }

            const cell = railMap.get(toKey(p.x, p.z));

            // 駅 (停止目標)
            if (cell && cell.type === 'station') {
                // 行き先駅と一致するか確認 (通過駅ならスルーするロジックも本来必要だが今は全て停車)
                // 今回はシンプルに「駅なら止まる」
                foundObstacle = true;
                obstacleType = 'station';
                break; 
            }

            // 信号 (赤なら停止目標)
            if (cell && cell.signalDir) {
                const prevGridForSignal = i === 0 ? currentGrid : localRoute[i-1];
                const dx = p.x - prevGridForSignal.x;
                const dz = p.z - prevGridForSignal.z;
                if (dx !== 0 || dz !== 0) {
                    const moveVec = new THREE.Vector3(dx, 0, dz).normalize();
                    const sv = getVectorFromDir(cell.signalDir);
                    const signalVec = new THREE.Vector3(sv.x, 0, sv.z).normalize();
                    
                    if (moveVec.dot(signalVec) > 0.1) {
                        const lookAheadStart = i + 1;
                        const lookAheadEnd = Math.min(localRoute.length, i + 10);
                        const blockSegment = localRoute.slice(lookAheadStart, lookAheadEnd);
                        
                        const conflict = allTrains.some(other => {
                             if (other.id === data.id) return false;
                             if (other.status !== 'running') return false;
                             
                             const otherCells = other.occupiedCells || [{x:other.x, z:other.z}];
                             if (blockSegment.some(bp => otherCells.some(oc => Math.round(oc.x)===bp.x && Math.round(oc.z)===bp.z))) return true;

                             const otherPath = other.reservedPath || [];
                             if (blockSegment.some(bp => otherPath.some(op => op.x===bp.x && op.z===bp.z))) {
                                 const myDir = moveVec;
                                 let otherDir = new THREE.Vector3(0,0,0);
                                 if (other.reservedPath && other.reservedPath.length>0) {
                                     const op = other.reservedPath[0];
                                     otherDir.set(op.x - other.x, 0, op.z - other.z).normalize();
                                 }
                                 if (myDir.dot(otherDir) > 0.5) return false;
                                 if (data.id < other.id) return false; 
                                 return true; 
                             }
                             return false;
                        });

                        if (conflict) {
                            foundObstacle = true;
                            obstacleType = 'signal';
                        }
                        if (foundObstacle) break;
                    }
                }
            }
        }
        
        limitDistance = foundObstacle ? distAccumulator : 9999;
    }

    // --- 3. 速度制御 ---
    const currentSpeedMs = speedRef.current / 3.6;
    const decelMs2 = DECEL_KMH_S / 3.6;
    const brakingDist = (Math.pow(currentSpeedMs, 2) / (2 * decelMs2));

    let targetSpeed = MAX_SPEED_KMH;

    if (immediateBlock) {
        targetSpeed = 0;
        speedRef.current = 0; 
    } else if (limitDistance <= brakingDist + 5.0) { 
        // ブレーキゾーン
        // ★修正: 駅の場合は距離が0になってもクリープ速度を維持する (到着イベント発火待ち)
        // 他の障害物(信号など)の場合は手前で止まる
        
        if (obstacleType === 'station') {
             targetSpeed = MIN_CRAWL_SPEED_KMH; // 駅なら絶対に止めない（到着判定に任せる）
             setDebugStatus(`Arriving... (${limitDistance.toFixed(1)}m)`);
        } else {
             // 信号待ちなどは 0.5m 手前で止まる
             if (limitDistance < 0.5) {
                 targetSpeed = 0;
                 setDebugStatus(`Waiting Signal... (${limitDistance.toFixed(1)}m)`);
             } else {
                 targetSpeed = MIN_CRAWL_SPEED_KMH;
                 setDebugStatus(`Braking... (${limitDistance.toFixed(1)}m)`);
             }
        }
    } else {
        setDebugStatus(`Accelerating (${Math.round(speedRef.current)} km/h)`);
    }

    if (speedRef.current < targetSpeed) {
        speedRef.current = Math.min(targetSpeed, speedRef.current + ACCEL_KMH_S * delta);
    } else {
        speedRef.current = Math.max(targetSpeed, speedRef.current - DECEL_KMH_S * delta);
    }

    // --- 4. 移動 ---
    const moveSpeedTilesPerSec = (speedRef.current / 3.6) / TILE_LENGTH;
    const geoDist = Math.sqrt(Math.pow(nextTile.x - currentGrid.x, 2) + Math.pow(nextTile.z - currentGrid.z, 2));
    const progressDelta = (moveSpeedTilesPerSec / (geoDist || 1)) * delta;
    const newProgress = progress + progressDelta;

    if (newProgress >= 1.0) {
      const arrivedGrid = nextTile;
      const oldCurrent = currentGrid;
      
      setCurrentGrid(arrivedGrid);
      setPrevGrid(oldCurrent);
      setProgress(0);
      
      const newLocalRoute = localRoute.slice(1);
      setLocalRoute(newLocalRoute);
      onUpdatePath(data.id, newLocalRoute);

      const newTrail = [arrivedGrid, ...trail];
      if (newTrail.length > TRAIN_LENGTH_TILES) newTrail.pop();
      setTrail(newTrail);

      // 駅到着判定
      let shouldStop = false;
      if (targetStationId) {
        const key = toKey(arrivedGrid.x, arrivedGrid.z);
        const cell = railMap.get(key);
        if (cell && cell.stationId === targetStationId) {
          const st = stations.get(targetStationId);
          if (st) {
             const distToCenter = Math.sqrt(Math.pow(arrivedGrid.x - st.center.x, 2) + Math.pow(arrivedGrid.z - st.center.z, 2));
             let keepGoing = false;
             if (newLocalRoute.length > 0) {
                const nextKey = toKey(newLocalRoute[0].x, newLocalRoute[0].z);
                const nextCell = railMap.get(nextKey);
                if (nextCell && nextCell.stationId === targetStationId) {
                   const nextDist = Math.sqrt(Math.pow(newLocalRoute[0].x - st.center.x, 2) + Math.pow(newLocalRoute[0].z - st.center.z, 2));
                   // 駅の中心に近づくなら進む
                   if (nextDist < distToCenter - 0.5) keepGoing = true;
                }
             }
             if (!keepGoing) shouldStop = true;
          }
        }
      }

      if (shouldStop) {
        setIsStopped(true);
        speedRef.current = 0;
        setLocalRoute([]);
        onUpdatePath(data.id, []);
        setPrevGrid(null);
        
        groupRef.current.position.set(arrivedGrid.x, 0.5, arrivedGrid.z);
        setDebugStatus("Arrived");
        
        setTimeout(() => {
          onArriveStation(data.id, data.scheduleIndex);
          setIsStopped(false);
        }, STOP_DURATION);
      } else {
        groupRef.current.position.set(arrivedGrid.x, 0.5, arrivedGrid.z);
      }
    } else {
      setProgress(newProgress);
      const currVec = new THREE.Vector3(currentGrid.x, 0.5, currentGrid.z);
      const nextVec = new THREE.Vector3(nextTile.x, 0.5, nextTile.z);
      groupRef.current.position.lerpVectors(currVec, nextVec, newProgress);
      groupRef.current.lookAt(nextVec);
    }
  });

  if (data.status === 'stored') return null;

  const color = isSelected ? SELECTED_TRAIN_COLOUR : TRAIN_COLOUR;

  return (
    <group>
      <group ref={groupRef} position={[data.x, 0.5, data.z]} onClick={(e) => { e.stopPropagation(); onClick(e); }}>
        {type === 'commuter' ? (
          <mesh>
            <boxGeometry args={[0.8, 0.8, 1.6]} />
            <meshStandardMaterial color={isWaiting ? '#ff9900' : color} />
          </mesh>
        ) : (
          <group>
            <mesh position={[0, 0, 0.2]}>
              <boxGeometry args={[0.7, 0.7, 1.8]} />
              <meshStandardMaterial color={isWaiting ? '#ff9900' : color} />
            </mesh>
            <mesh position={[0, 0, 1.3]} rotation={[Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.35, 0.8, 4]} />
              <meshStandardMaterial color={isWaiting ? '#ff9900' : color} />
            </mesh>
          </group>
        )}
        {isSelected && (
          <mesh position={[0, 1.5, 0]}>
            <coneGeometry args={[0.2, 0.5, 4]} />
            <meshBasicMaterial color={SELECTED_TRAIN_COLOUR} />
          </mesh>
        )}

        {isSelected && (
          <Html position={[0, 2.5, 0]} center style={{ pointerEvents: 'none', width: '200px', textAlign: 'center' }}>
            <div style={{ 
              background: 'rgba(0,0,0,0.8)', color: 'white', padding: '4px 8px', 
              borderRadius: '4px', fontSize: '11px', fontFamily: 'monospace',
              border: '1px solid #666'
            }}>
              <div>{data.id}</div>
              <div style={{ color: '#aaffaa', fontWeight:'bold' }}>
                {Math.round(speedRef.current)} km/h
              </div>
              <div style={{ color: '#ccc' }}>{debugStatus}</div>
            </div>
          </Html>
        )}
      </group>

      {localRoute.map((pos, i) => (
        <mesh key={`route-${i}`} position={[pos.x, 0.5, pos.z]}>
          <sphereGeometry args={[0.08]} />
          <meshBasicMaterial color="#ffff00" transparent opacity={0.3} />
        </mesh>
      ))}
    </group>
  );
};