import { useState, useRef, useEffect } from 'react';
import { toKey } from '../utils';
import type { CellData, CellType, TrainData, StationData } from '../types';
import type { SimWorld } from '../sim/simulation';
import { serialiseWorld, deserialiseWorld } from '../sim/persistence';
import type { SaveData } from '../sim/persistence';
import { applyRailPath, applyStation, applyDepot, applySignal, removePath } from '../sim/construction';
import type { ConstructionState } from '../sim/construction';

const SAVE_KEY = 'cubictransim-save-v1';

export const useGameLogic = () => {
  const [railMap, setRailMap] = useState<Map<string, CellData>>(new Map());
  const [stations, setStations] = useState<Map<string, StationData>>(new Map());
  const [trains, setTrains] = useState<TrainData[]>([]);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);

  // ★追加: スケジュール用クリップボード
  const [scheduleClipboard, setScheduleClipboard] = useState<string[] | null>(null);

  // シミュレーション世界の実体。runtimesは列車IDごとに保持し続け、
  // railMap/stations/trainsはReact stateが更新されるたびに差し替える。
  const worldRef = useRef<SimWorld>({
    railMap: new Map(),
    stations: new Map(),
    trains: [],
    runtimes: new Map(),
  });

  useEffect(() => {
    worldRef.current.railMap = railMap;
  }, [railMap]);

  useEffect(() => {
    worldRef.current.stations = stations;
  }, [stations]);

  useEffect(() => {
    worldRef.current.trains = trains;
  }, [trains]);

  // --- Commit Path ---
  // railMap/stations の更新ロジックは sim/construction.ts の純粋関数に委譲する。
  // ここでは現在の state を渡し、結果をまとめて setRailMap/setStations するだけの薄いラッパー。
  const commitPath = (path: { x: number; z: number }[], buildMode: CellType | 'none' | 'remove' | 'signal') => {
    if (path.length === 0) return;

    const state: ConstructionState = { railMap, stations };
    let result: ConstructionState;

    switch (buildMode) {
      case 'remove':
        result = removePath(state, path);
        break;
      case 'signal':
        result = applySignal(state, path);
        break;
      case 'station':
        result = applyStation(state, path[path.length - 1]);
        break;
      case 'depot':
        result = applyDepot(state, path[path.length - 1]);
        break;
      case 'rail':
        result = applyRailPath(state, path);
        break;
      default:
        return;
    }

    setRailMap(result.railMap);
    setStations(result.stations);
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
    };
    setTrains(prev => [...prev, newTrain]);
    setSelectedTrainId(newTrain.id);
    setIsEditingSchedule(false);
  };

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

  // ★追加: スケジュールコピー機能
  const copySchedule = (trainId: string) => {
    const target = trains.find(t => t.id === trainId);
    if (target) {
      setScheduleClipboard([...target.schedule]);
    }
  };

  // ★追加: スケジュールペースト機能
  const pasteSchedule = (trainId: string) => {
    if (!scheduleClipboard) return;
    setTrains(prev => prev.map(t => {
      if (t.id === trainId) {
        return { ...t, schedule: [...scheduleClipboard], scheduleIndex: 0 };
      }
      return t;
    }));
  };

  // ★追加: セーブ／ロード
  const saveGame = () => {
    const saveData = serialiseWorld(railMap, stations, trains, worldRef.current.runtimes);
    localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
  };

  const loadGame = () => {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      console.warn('No save data found.');
      return;
    }
    const saveData = JSON.parse(raw) as SaveData;
    const restored = deserialiseWorld(saveData);

    setRailMap(restored.railMap);
    setStations(restored.stations);
    setTrains(restored.trains);

    // runtimes は DynamicTrain が Map インスタンスを参照し続けているため、
    // 差し替えず中身だけ入れ替える。
    worldRef.current.runtimes.clear();
    restored.runtimes.forEach((rt, id) => worldRef.current.runtimes.set(id, rt));
  };

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
    worldRef,
    // 公開
    scheduleClipboard,
    copySchedule,
    pasteSchedule,
    saveGame,
    loadGame
  };
};