import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TRAIN_COLOUR, SELECTED_TRAIN_COLOUR } from '../types';
import type { TrainType, CellData, TrainData, StationData } from '../types';
import { toKey, DIR } from '../utils';

const STOP_DURATION = 3000;

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
}

// ヘルパー: 方向ビットをベクトルに変換
const getVectorFromDir = (dir: number) => {
  if (dir === DIR.N) return { x: 0, z: -1 };
  if (dir === DIR.S) return { x: 0, z: 1 };
  if (dir === DIR.E) return { x: 1, z: 0 };
  if (dir === DIR.W) return { x: -1, z: 0 };
  if (dir === DIR.NE) return { x: 1, z: -1 };
  if (dir === DIR.SE) return { x: 1, z: 1 };
  if (dir === DIR.SW) return { x: -1, z: 1 };
  if (dir === DIR.NW) return { x: -1, z: -1 };
  return { x: 0, z: 0 };
};

export const DynamicTrain: React.FC<DynamicTrainProps> = ({ 
  data, type, railMap, stations, allTrains, isSelected, onArriveStation, onClick, onUpdatePath
}) => {
  const groupRef = useRef<THREE.Group>(null);
  
  const [currentGrid, setCurrentGrid] = useState({ x: data.x, z: data.z });
  const [nextGrid, setNextGrid] = useState<{ x: number; z: number } | null>(null);
  const [prevGrid, setPrevGrid] = useState<{ x: number; z: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [isStopped, setIsStopped] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  
  const [localRoute, setLocalRoute] = useState<{ x: number; z: number }[]>([]);
  const [currentBlock, setCurrentBlock] = useState<{ x: number; z: number }[]>([]);

  const speed = 2.0;
  const targetStationId = data.schedule.length > 0 ? data.schedule[data.scheduleIndex] : null;

  // --- 経路探索 (BFS) ---
  const calculateRoute = (start: { x: number, z: number }, targetId: string) => {
    const targetSt = stations.get(targetId);
    if (!targetSt) return [];

    const queue: { curr: { x: number, z: number }, path: { x: number, z: number }[], prev: { x: number, z: number } | null }[] = [
      { curr: start, path: [], prev: prevGrid } 
    ];

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
        
        // 経路探索時の信号チェック (ここも厳密にしすぎるとルートが見つからないので、
        // 完全に逆向きのときだけ弾くように緩和)
        const targetKey = toKey(tx, tz);
        const targetCell = railMap.get(targetKey);
        if (targetCell && targetCell.signalDir) {
          const sv = getVectorFromDir(targetCell.signalDir);
          const dv = { x: d.x, z: d.z }; // d is already normalized-ish direction
          // 内積計算 (簡易)
          const dot = sv.x * dv.x + sv.z * dv.z; 
          // dot > 0 なら順方向、dot < 0 なら逆方向。0は直角。
          // 斜め移動も考慮して、少しでも順方向成分があればOKとする (-0.1くらい)
          if (dot < -0.1) continue; 
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
    return [];
  };

  useEffect(() => {
    if (data.status === 'running' && targetStationId) {
      if (localRoute.length === 0 && !isStopped) {
        const newPath = calculateRoute(currentGrid, targetStationId);
        if (newPath.length > 0) {
          setLocalRoute(newPath);
          onUpdatePath(data.id, newPath);
        }
      }
    }
  }, [data.status, targetStationId, currentGrid, isStopped, localRoute.length]); 

  useFrame((_state, delta) => {
    if (data.status !== 'running') return;
    if (isStopped || !groupRef.current) return;
    if (localRoute.length === 0) return;

    const nextTile = localRoute[0];

    // --- ★衝突・閉塞チェック (修正版) ---
    let blocked = false;

    // 1. 直前のマスの物理的占有チェック (これは絶対)
    const isPhysicallyOccupied = allTrains.some(t => {
      if (t.id === data.id) return false;
      return Math.round(t.x) === nextTile.x && Math.round(t.z) === nextTile.z;
    });
    if (isPhysicallyOccupied) blocked = true;

    // 2. 閉塞区間 (Safety Block) の決定
    const checkSegment: { x: number, z: number }[] = [];
    
    for (let i = 0; i < localRoute.length; i++) {
      const p = localRoute[i];
      checkSegment.push(p);

      const cell = railMap.get(toKey(p.x, p.z));
      
      if (cell && cell.type === 'station') {
        break; 
      }

      // ★修正: 信号判定 (斜め移動対応)
      if (cell && cell.signalDir) {
        const prevP = i === 0 ? currentGrid : localRoute[i-1];
        const dx = p.x - prevP.x;
        const dz = p.z - prevP.z;
        
        if (dx !== 0 || dz !== 0) {
            const moveVec = new THREE.Vector3(dx, 0, dz).normalize();
            const sv = getVectorFromDir(cell.signalDir);
            const signalVec = new THREE.Vector3(sv.x, 0, sv.z).normalize();
            
            // 進行方向と信号の向きの内積をとる
            // 0.1以上（だいたい同じ向き）なら、有効な信号として認識し、ブロック区切りとする
            if (moveVec.dot(signalVec) > 0.1) {
               break;
            }
        }
      }
    }
    
    if (JSON.stringify(currentBlock) !== JSON.stringify(checkSegment)) {
        setCurrentBlock(checkSegment);
    }

    // 3. 閉塞区間内の安全確認
    if (!blocked) {
      // ★修正: 車庫(Depot)にいる間は、閉塞チェック(予約重複チェック)をスキップする
      // これにより「とりあえず外に出る」ことが可能になる
      const currentKey = toKey(currentGrid.x, currentGrid.z);
      const currentCell = railMap.get(currentKey);
      const isInDepot = currentCell && currentCell.type === 'depot';

      if (!isInDepot) {
        const conflict = allTrains.some(other => {
          if (other.id === data.id) return false;
          if (other.status !== 'running') return false;
          
          // A. 物理的在線
          const isPhysicallyBlocking = checkSegment.some(p => 
            Math.round(other.x) === p.x && Math.round(other.z) === p.z
          );
          if (isPhysicallyBlocking) return true;

          // B. 予約重複
          const otherPath = other.reservedPath || [];
          const hasReservationConflict = checkSegment.some(myP => 
            otherPath.some(otherP => otherP.x === myP.x && otherP.z === myP.z)
          );
          return hasReservationConflict;
        });

        if (conflict) blocked = true;
      }
    }

    if (blocked) {
      if (!isWaiting) setIsWaiting(true);
      return; // 進まない
    }
    if (isWaiting) setIsWaiting(false);

    // --- 移動処理 ---
    const dist = Math.sqrt(Math.pow(nextTile.x - currentGrid.x, 2) + Math.pow(nextTile.z - currentGrid.z, 2));
    const normalizedSpeed = speed / (dist || 1);
    const newProgress = progress + (normalizedSpeed * delta);

    if (newProgress >= 1.0) {
      const arrivedGrid = nextTile;
      const oldCurrent = currentGrid;
      
      setCurrentGrid(arrivedGrid);
      setPrevGrid(oldCurrent);
      setProgress(0);
      
      const newLocalRoute = localRoute.slice(1);
      setLocalRoute(newLocalRoute);
      onUpdatePath(data.id, newLocalRoute);

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
                   if (nextDist < distToCenter - 0.1) keepGoing = true;
                }
             }
             if (!keepGoing) shouldStop = true;
          }
        }
      }

      if (shouldStop) {
        setIsStopped(true);
        setLocalRoute([]);
        onUpdatePath(data.id, []);
        setPrevGrid(null);
        
        groupRef.current.position.set(arrivedGrid.x, 0.5, arrivedGrid.z);
        
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
      </group>

      {localRoute.map((pos, i) => (
        <mesh key={`route-${i}`} position={[pos.x, 0.5, pos.z]}>
          <sphereGeometry args={[0.08]} />
          <meshBasicMaterial color="#ffff00" transparent opacity={0.3} />
        </mesh>
      ))}
      
      {currentBlock.map((pos, i) => (
        <mesh key={`block-${i}`} position={[pos.x, 0.6, pos.z]}>
          <sphereGeometry args={[0.12]} />
          <meshBasicMaterial color="#ff6600" transparent opacity={0.8} />
        </mesh>
      ))}
    </group>
  );
};