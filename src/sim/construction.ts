import { toKey, getDirFromVector, getOppositeDir, getVectorFromDir, DIR } from '../utils';
import type { CellData, StationData, TerrainType } from '../types';
import { terrainAt } from './terrain';

// 橋の全長(橋台含むセル数)の下限・上限。3未満は橋桁が0になり橋の意味が無く、
// 10を超える長さは建設UIの想定外(コストも高額になりすぎる)としてno-opにする。
export const MAX_BRIDGE_LENGTH = 10;
const MIN_BRIDGE_LENGTH = 3;

export interface ConstructionState {
  railMap: Map<string, CellData>;
  stations: Map<string, StationData>;
}

type Pos = { x: number; z: number };

// terrain省略時は空Map(=すべて平地)扱いにする。既存呼び出し・既存テストとの互換のため。
const EMPTY_TERRAIN: Map<string, TerrainType> = new Map();

// セルが水域・山岳かどうか(駅・車庫・信号は平地にしか置けない)。
const isBuildableGround = (terrain: Map<string, TerrainType>, x: number, z: number): boolean =>
  terrainAt(terrain, x, z) === 'grass';

// --- ヘルパー ---
const updateDepotRotation = (map: Map<string, CellData>, x: number, z: number) => {
  const key = toKey(x, z);
  const cell = map.get(key);
  if (!cell || cell.type !== 'depot') return;

  const neighbours = [
    { dx: 0, dz: -1, rot: 0 },
    { dx: 1, dz: 0, rot: -Math.PI / 2 },
    { dx: 0, dz: 1, rot: Math.PI },
    { dx: -1, dz: 0, rot: Math.PI / 2 },
  ];

  let bestRot = cell.rotation || 0;
  let found = false;

  for (const n of neighbours) {
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

// バグ5対策: 既存駅名を走査し、A から順に未使用の文字を割り当てる。
// 孤児駅（隣接がなくなった駅）を消しても採番が飛ばない。
// 表記は日本語に統一しているため「A駅」形式で採番する(旧セーブの
// "Station A" 形式の駅名はそのまま保持され、採番の重複判定にも影響しない)。
export const nextStationName = (stations: Map<string, StationData>): string => {
  const used = new Set(Array.from(stations.values()).map(s => s.name));
  let suffix = 1;
  // まずは A〜Z の単純な名前を試し、尽きたら数字サフィックス付きに進む
  while (true) {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      const name = suffix === 1 ? `${letter}駅` : `${letter}${suffix}駅`;
      if (!used.has(name)) return name;
    }
    suffix++;
  }
};

// terrainに応じたbridge/tunnelフラグ(描画用)。平地ならどちらも付かない。
const terrainFlags = (terrain: Map<string, TerrainType>, x: number, z: number): Pick<CellData, 'bridge' | 'tunnel'> => {
  const t = terrainAt(terrain, x, z);
  if (t === 'water') return { bridge: true };
  if (t === 'mountain') return { tunnel: true };
  return { bridge: undefined, tunnel: undefined };
};

// 既存セルにdir方向の接続を1つ足す。常に地平のconnectionsへOR(平面交差方式)。
// 直角に交差する線路は4方向接続の1セル(ダイヤモンドクロッシング)になる。
const addConnectionToCell = (
  railMap: Map<string, CellData>,
  key: string,
  x: number,
  z: number,
  dir: number,
  terrain: Map<string, TerrainType>
): void => {
  const existing = railMap.get(key);
  if (!existing) {
    railMap.set(key, { type: 'rail', connections: dir, ...terrainFlags(terrain, x, z) });
  } else if (existing.type !== 'rail') {
    railMap.set(key, { ...existing, connections: (existing.connections || 0) | dir });
  } else {
    railMap.set(key, { ...existing, connections: (existing.connections || 0) | dir, ...terrainFlags(terrain, x, z) });
  }
};

export interface RailPathApplyResult extends ConstructionState {
  /**
   * このpath適用によって立体交差(upper)になった/拡張されたセルのキー集合。
   * 自動高架は廃止したため、線路敷設(applyRailPath)では常に空集合になる。
   * 橋(applyBridge)では別途橋桁セルの集合をoverpassCells相当として扱う
   * (evaluateBuild側でbridge専用に計算する)。
   */
  overpassCells: Set<string>;
}

// applyRailPathの詳細版。overpassCellsは自動高架の廃止により常に空集合。
// 呼び出し側(economy.costOfPath等)との互換のため型は維持している。
export function applyRailPathDetailed(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): RailPathApplyResult {
  const railMap = new Map(state.railMap);
  const overpassCells = new Set<string>();

  for (let i = 0; i < path.length - 1; i++) {
    const curr = path[i];
    const next = path[i + 1];
    const currKey = toKey(curr.x, curr.z);
    const nextKey = toKey(next.x, next.z);
    const dx = next.x - curr.x;
    const dz = next.z - curr.z;
    const dir = getDirFromVector(dx, dz);
    const oppDir = getOppositeDir(dir);

    addConnectionToCell(railMap, currKey, curr.x, curr.z, dir, terrain);
    if (railMap.get(currKey)?.type === 'depot') updateDepotRotation(railMap, curr.x, curr.z);

    addConnectionToCell(railMap, nextKey, next.x, next.z, oppDir, terrain);
    if (railMap.get(nextKey)?.type === 'depot') updateDepotRotation(railMap, next.x, next.z);

    const checkDepotNeighbours = (px: number, pz: number) => {
      const nbs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
      nbs.forEach(n => updateDepotRotation(railMap, px + n.x, pz + n.z));
    };
    checkDepotNeighbours(curr.x, curr.z);
    checkDepotNeighbours(next.x, next.z);
  }

  return { railMap, stations: state.stations, overpassCells };
}

export function applyRailPath(state: ConstructionState, path: Pos[], terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  return applyRailPathDetailed(state, path, terrain);
}

export function applyStation(state: ConstructionState, pos: Pos, terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existingBeforeUpdate = state.railMap.get(key);

  // 駅は平地にしか置けない: 水域・山岳セルへの設置は no-op(課金もされない)
  if (!isBuildableGround(terrain, pos.x, pos.z)) {
    return state;
  }

  // バグ1/2対策: すでに駅・車庫があるセルへの再設置は no-op
  if (existingBeforeUpdate && (existingBeforeUpdate.type === 'station' || existingBeforeUpdate.type === 'depot')) {
    return state;
  }

  const railMap = new Map(state.railMap);
  const stations = new Map(state.stations);

  const neighbours = [
    { x: pos.x + 1, z: pos.z },
    { x: pos.x - 1, z: pos.z },
    { x: pos.x, z: pos.z + 1 },
    { x: pos.x, z: pos.z - 1 },
  ];
  let foundStationId: string | null = null;
  for (const n of neighbours) {
    const nKey = toKey(n.x, n.z);
    const cell = railMap.get(nKey);
    if (cell && cell.type === 'station' && cell.stationId) {
      foundStationId = cell.stationId;
      break;
    }
  }

  let targetId = foundStationId;
  if (!targetId) {
    targetId = Math.random().toString(36).substr(2, 9);
    const newName = nextStationName(stations);
    stations.set(targetId, { id: targetId, name: newName, cells: [{ x: pos.x, z: pos.z }], center: { x: pos.x, z: pos.z }, platformDoors: 'none' });
  } else {
    const sid = targetId;
    const st = stations.get(sid);
    if (st) {
      const newCells = [...st.cells, { x: pos.x, z: pos.z }];
      const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
      const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
      stations.set(sid, { ...st, cells: newCells, center: { x: cx, z: cz } });
    }
  }

  // バグ3対策: 既存の rail セルを駅化する場合は connections を維持する。
  // 空セルに新規設置する場合のみ N|E|S|W で初期化する。
  const connections = existingBeforeUpdate && existingBeforeUpdate.type === 'rail'
    ? (existingBeforeUpdate.connections || 0)
    : (DIR.N | DIR.E | DIR.S | DIR.W);

  railMap.set(key, { type: 'station', connections, stationId: targetId });
  neighbours.forEach(n => updateDepotRotation(railMap, n.x, n.z));

  return { railMap, stations };
}

export function applyDepot(state: ConstructionState, pos: Pos, terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  const key = toKey(pos.x, pos.z);
  const existing = state.railMap.get(key);

  // 車庫は平地にしか置けない: 水域・山岳セルへの設置は no-op(課金もされない)
  if (!isBuildableGround(terrain, pos.x, pos.z)) {
    return state;
  }

  // バグ1対策: 空セル以外への設置は no-op（駅の上に車庫を置いて駅を消してしまわないように）
  if (existing) {
    return state;
  }

  const railMap = new Map(state.railMap);
  railMap.set(key, { type: 'depot', connections: DIR.N | DIR.E | DIR.S | DIR.W, rotation: 0 });
  updateDepotRotation(railMap, pos.x, pos.z);

  return { railMap, stations: state.stations };
}

export function applySignal(state: ConstructionState, path: Pos[], terrain: Map<string, TerrainType> = EMPTY_TERRAIN): ConstructionState {
  const pos = path[0];
  const key = toKey(pos.x, pos.z);
  const cell = state.railMap.get(key);
  if (!cell || (cell.type !== 'rail' && cell.type !== 'station')) return state;
  // 信号は平地にしか置けない: 橋・トンネル区間(水域・山岳)への設置は no-op
  if (!isBuildableGround(terrain, pos.x, pos.z)) return state;

  const railMap = new Map(state.railMap);
  const conns = cell.connections || 0;

  if (!cell.signalDir) {
    let firstDir = DIR.N;
    const dirs = [DIR.N, DIR.E, DIR.S, DIR.W, DIR.NE, DIR.SE, DIR.SW, DIR.NW];
    for (const d of dirs) {
      if (conns & d) {
        firstDir = d;
        break;
      }
    }
    railMap.set(key, { ...cell, signalDir: firstDir });
  } else {
    const currentDir = cell.signalDir;
    let nextDir = currentDir;
    const dirs = [DIR.N, DIR.NE, DIR.E, DIR.SE, DIR.S, DIR.SW, DIR.W, DIR.NW];
    const idx = dirs.indexOf(currentDir);
    for (let i = 1; i <= 8; i++) {
      const d = dirs[(idx + i) % 8];
      if (conns & d) {
        nextDir = d;
        break;
      }
    }
    railMap.set(key, { ...cell, signalDir: nextDir });
  }

  return { railMap, stations: state.stations };
}

// TTD/OpenTTD流の橋。始点(path[0])・終点(path末尾)が橋台(地平の通常線路)、
// 中間セルが橋桁(upper.connectionsのみ。地平のconnectionsは一切変更しない)になる。
// これにより橋の下に平面交差(ダイヤモンドクロッシング)や別の地平線路を通せる。
//
// 建設不可条件(いずれか1つでも該当すれば no-op、state をそのまま返す):
// - 全長(path.length)が MIN_BRIDGE_LENGTH 未満 or MAX_BRIDGE_LENGTH 超
// - 始点〜終点が8方向直線上に等間隔で並んでいない
// - 橋台セル(始点・終点)が水域・山岳
// - 橋桁セル(中間)が駅・車庫
// - 橋桁セルに既にupperがある(二重架け禁止)
export function applyBridge(
  state: ConstructionState,
  path: Pos[],
  terrain: Map<string, TerrainType> = EMPTY_TERRAIN
): ConstructionState {
  if (path.length < MIN_BRIDGE_LENGTH || path.length > MAX_BRIDGE_LENGTH) return state;

  const start = path[0];
  const second = path[1];
  const end = path[path.length - 1];
  const dir = getDirFromVector(second.x - start.x, second.z - start.z);
  if (dir === 0) return state; // 隣接しない/同一セル指定など

  const oppDir = getOppositeDir(dir);
  const step = getVectorFromDir(dir);

  // 始点から終点までstep刻みの直線上に等間隔で並んでいるか(斜めも含む8方向)確認する
  for (let i = 0; i < path.length; i++) {
    const expectedX = start.x + step.x * i;
    const expectedZ = start.z + step.z * i;
    if (path[i].x !== expectedX || path[i].z !== expectedZ) return state;
  }

  // 橋台は水域・山岳に置けない
  if (!isBuildableGround(terrain, start.x, start.z)) return state;
  if (!isBuildableGround(terrain, end.x, end.z)) return state;

  // 橋桁(中間セル)は駅・車庫でないこと、既にupperが無いこと
  const middle = path.slice(1, -1);
  for (const cell of middle) {
    const existing = state.railMap.get(toKey(cell.x, cell.z));
    if (existing && (existing.type === 'station' || existing.type === 'depot')) return state;
    if (existing?.upper) return state;
  }

  const railMap = new Map(state.railMap);

  // 橋台: 通常の地平線路として敷設する(既存線路があれば接続を足すだけ)
  const startKey = toKey(start.x, start.z);
  const endKey = toKey(end.x, end.z);
  addConnectionToCell(railMap, startKey, start.x, start.z, dir, terrain);
  addConnectionToCell(railMap, endKey, end.x, end.z, oppDir, terrain);
  if (railMap.get(startKey)?.type === 'depot') updateDepotRotation(railMap, start.x, start.z);
  if (railMap.get(endKey)?.type === 'depot') updateDepotRotation(railMap, end.x, end.z);

  // 橋桁: upper.connectionsのみに軸方向の接続(dir|oppDir)を入れる。地平は不変。
  for (const cell of middle) {
    const key = toKey(cell.x, cell.z);
    const existing = railMap.get(key);
    railMap.set(key, {
      ...(existing ?? { type: 'rail' }),
      upper: { connections: dir | oppDir },
    });
  }

  return { railMap, stations: state.stations };
}

export function removePath(state: ConstructionState, path: Pos[]): ConstructionState {
  const railMap = new Map(state.railMap);
  const stations = new Map(state.stations);

  path.forEach(pos => {
    const key = toKey(pos.x, pos.z);
    const cell = railMap.get(key);
    if (!cell) return;

    // 橋桁セル(upperを持ち、かつ地平のconnectionsも独立して存在する)をまるごと
    // 撤去した場合は、upperだけを消して地平の線路(下を通る別の経路)を残す。
    if (cell.upper?.connections && (cell.connections ?? 0) !== 0) {
      railMap.set(key, { ...cell, upper: undefined });
      return;
    }

    railMap.delete(key);
    if (cell.type === 'station' && cell.stationId) {
      const sid = cell.stationId;
      const st = stations.get(sid);
      if (st) {
        const newCells = st.cells.filter(c => c.x !== pos.x || c.z !== pos.z);
        if (newCells.length === 0) {
          stations.delete(sid);
        } else {
          const cx = newCells.reduce((sum, c) => sum + c.x, 0) / newCells.length;
          const cz = newCells.reduce((sum, c) => sum + c.z, 0) / newCells.length;
          stations.set(sid, { ...st, cells: newCells, center: { x: cx, z: cz } });
        }
      }
    }

    const neighbours = [
      { x: pos.x, z: pos.z - 1, opp: DIR.S },
      { x: pos.x + 1, z: pos.z - 1, opp: DIR.SW },
      { x: pos.x + 1, z: pos.z, opp: DIR.W },
      { x: pos.x + 1, z: pos.z + 1, opp: DIR.NW },
      { x: pos.x, z: pos.z + 1, opp: DIR.N },
      { x: pos.x - 1, z: pos.z + 1, opp: DIR.NE },
      { x: pos.x - 1, z: pos.z, opp: DIR.E },
      { x: pos.x - 1, z: pos.z - 1, opp: DIR.SE },
    ];
    neighbours.forEach(n => {
      const nKey = toKey(n.x, n.z);
      const nCell = railMap.get(nKey);
      if (nCell) {
        // 撤去は地平・高架の両方のconnectionsから該当ビットを消す。
        let updated = nCell;
        if (nCell.connections) {
          updated = { ...updated, connections: nCell.connections & ~n.opp };
        }
        if (nCell.upper?.connections) {
          const remainingUpper = nCell.upper.connections & ~n.opp;
          updated = { ...updated, upper: remainingUpper === 0 ? undefined : { connections: remainingUpper } };
        }
        if (updated !== nCell) railMap.set(nKey, updated);
        if (nCell.type === 'depot') updateDepotRotation(railMap, n.x, n.z);
      }
    });
  });

  return { railMap, stations };
}
