import { useState, useRef, useEffect } from 'react';
import { toKey } from '../utils';
import type { CellData, CellType, TrainData, StationData, PlatformDoorType } from '../types';
import type { SimWorld, SimEvent } from '../sim/simulation';
import { serialiseWorld, deserialiseWorld } from '../sim/persistence';
import type { SaveData } from '../sim/persistence';
import { applyRailPath, applyStation, applyDepot, applySignal, removePath } from '../sim/construction';
import type { ConstructionState } from '../sim/construction';
import { STARTING_MONEY, TRAIN_COST, costOfPath, PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST } from '../sim/economy';

const SAVE_KEY = 'cubictransim-save-v1';

// 事故バナー表示用の通知の生存確認間隔(ms)。該当列車のhaltRemainingが0になったら消す。
const ACCIDENT_POLL_INTERVAL_MS = 500;

export interface AccidentNotice {
  trainId: string;
  stationId: string;
}

export const useGameLogic = () => {
  const [railMap, setRailMap] = useState<Map<string, CellData>>(new Map());
  const [stations, setStations] = useState<Map<string, StationData>>(new Map());
  const [trains, setTrains] = useState<TrainData[]>([]);
  const [selectedTrainId, setSelectedTrainId] = useState<string | null>(null);
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [isEditingSchedule, setIsEditingSchedule] = useState(false);

  // ★追加: 人身事故の通知(バナー表示用)。列車のhaltRemainingが尽きたら自動的に消える。
  const [activeAccidents, setActiveAccidents] = useState<AccidentNotice[]>([]);

  // ★追加: スケジュール用クリップボード
  const [scheduleClipboard, setScheduleClipboard] = useState<string[] | null>(null);

  // ★追加: 所持金。建設・列車購入のたびに減算し、運賃収入で増加する。
  const [money, setMoney] = useState<number>(STARTING_MONEY);

  // シミュレーション世界の実体。runtimes/waitingは列車ID/駅IDごとに保持し続け、
  // railMap/stations/trainsはReact stateが更新されるたびに差し替える。
  const worldRef = useRef<SimWorld>({
    railMap: new Map(),
    stations: new Map(),
    trains: [],
    runtimes: new Map(),
    waiting: new Map(),
    rng: Math.random,
    economyMirror: { money: STARTING_MONEY },
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

  // economyMirrorはデバッグ/表示用のReact state鏡写しで、simロジックからは参照されない。
  useEffect(() => {
    worldRef.current.economyMirror = { money };
  }, [money]);

  // ★追加: 事故バナーの自動消去。該当列車のhaltRemainingが尽きたら通知を取り除く。
  useEffect(() => {
    const id = setInterval(() => {
      setActiveAccidents(prev =>
        prev.filter(a => {
          const rt = worldRef.current.runtimes.get(a.trainId);
          return rt ? rt.haltRemaining > 0 : false;
        })
      );
    }, ACCIDENT_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // --- Commit Path ---
  // railMap/stations の更新ロジックは sim/construction.ts の純粋関数に委譲する。
  // ここでは現在の state を渡し、結果をまとめて setRailMap/setStations するだけの薄いラッパー。
  // 建設コストの算出・所持金チェック・課金もここで行う。
  const commitPath = (path: { x: number; z: number }[], buildMode: CellType | 'none' | 'remove' | 'signal') => {
    if (path.length === 0) return;

    const state: ConstructionState = { railMap, stations };
    let result: ConstructionState;
    let cost = 0;

    switch (buildMode) {
      case 'remove':
        // 撤去は無料・払い戻しなし
        result = removePath(state, path);
        break;
      case 'signal':
        cost = costOfPath('signal', path.length);
        if (money < cost) return;
        result = applySignal(state, path);
        break;
      case 'station':
        cost = costOfPath('station', path.length);
        if (money < cost) return;
        result = applyStation(state, path[path.length - 1]);
        break;
      case 'depot':
        cost = costOfPath('depot', path.length);
        if (money < cost) return;
        result = applyDepot(state, path[path.length - 1]);
        break;
      case 'rail':
        cost = costOfPath('rail', path.length);
        if (money < cost) return;
        result = applyRailPath(state, path);
        break;
      default:
        return;
    }

    // no-op(上書き防止などで変化が無かった)場合は課金しない。
    // construction.ts の apply 系は変化が無ければ同一参照を返す実装になっている。
    const changed = result.railMap !== state.railMap || result.stations !== state.stations;
    if (changed && cost > 0) {
      setMoney(m => m - cost);
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
    if (money < TRAIN_COST) return;
    const newTrain: TrainData = {
        id: Math.random().toString(36).substr(0, 4),
        x, z,
        schedule: [], scheduleIndex: 0, status: 'stored',
    };
    setTrains(prev => [...prev, newTrain]);
    setSelectedTrainId(newTrain.id);
    setIsEditingSchedule(false);
    setMoney(m => m - TRAIN_COST);
  };

  // ★追加: 運賃収入の反映(sim層の'income'イベントを受けて呼ばれる)
  const addIncome = (amount: number) => {
    setMoney(m => m + amount);
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
    setSelectedStationId(null);
  };

  // ★追加: 駅選択(列車選択とは排他)。列車未選択かつスケジュール編集中でない場合のみ
  // GameScene側から呼ばれる。
  const selectStation = (id: string | null) => {
    setSelectedStationId(id);
    setSelectedTrainId(null);
    setIsEditingSchedule(false);
  };

  // ★追加: ホームドアのアップグレード。ダウングレードは不可。
  const upgradeStationDoors = (stationId: string, doorType: PlatformDoorType) => {
    const target = stations.get(stationId);
    if (!target) return;
    if (doorType === 'standard' && target.platformDoors !== 'none') return;
    if (doorType === 'fullscreen' && target.platformDoors === 'fullscreen') return;

    const cost = doorType === 'fullscreen' ? PLATFORM_DOOR_FULLSCREEN_COST : PLATFORM_DOOR_STANDARD_COST;
    if (money < cost) return;

    setStations(prev => {
      const next = new Map(prev);
      const st = next.get(stationId);
      if (!st) return prev;
      next.set(stationId, { ...st, platformDoors: doorType });
      return next;
    });
    setMoney(m => m - cost);
  };

  // ★追加: 人身事故イベントの反映(賠償金の減算 + バナー通知の追加)
  const handleAccident = (event: Extract<SimEvent, { type: 'accident' }>) => {
    setMoney(m => m - event.penalty);
    setActiveAccidents(prev => [...prev, { trainId: event.trainId, stationId: event.stationId }]);
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
    const saveData = serialiseWorld(railMap, stations, trains, worldRef.current.runtimes, worldRef.current.waiting, money);
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
    setMoney(restored.money);

    // runtimes/waiting は DynamicTrain/StationLabel が Map インスタンスを参照し続けているため、
    // 差し替えず中身だけ入れ替える。
    worldRef.current.runtimes.clear();
    restored.runtimes.forEach((rt, id) => worldRef.current.runtimes.set(id, rt));
    worldRef.current.waiting.clear();
    restored.waiting.forEach((count, id) => worldRef.current.waiting.set(id, count));
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
    loadGame,
    // ★追加: 経済システム
    money,
    addIncome,
    // ★追加: 人身事故とホームドア
    selectedStationId,
    selectStation,
    upgradeStationDoors,
    activeAccidents,
    handleAccident,
  };
};