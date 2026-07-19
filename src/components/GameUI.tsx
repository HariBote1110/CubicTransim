import React, { useEffect, useState } from 'react';
import { STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellType, TrainData, StationData, PlatformDoorType } from '../types';
import {
  RAIL_COST, STATION_COST, DEPOT_COST, SIGNAL_COST, CAPACITY_PER_CAR,
  CAR_COST, CAR_REFUND,
  PLATFORM_DOOR_STANDARD_COST, PLATFORM_DOOR_FULLSCREEN_COST,
  demandFactor, clockToDate,
} from '../sim/economy';
import type { MonthlyLedger } from '../sim/economy';
import type { SimWorld } from '../sim/simulation';
import type { AccidentNotice } from '../hooks/useGameLogic';

// ゲーム内日付表示の更新間隔(ms)。他のポーリングと同様、低頻度で十分。
const CLOCK_POLL_INTERVAL_MS = 500;

const formatSigned = (n: number) => {
  const rounded = Math.floor(n);
  return `${rounded < 0 ? '-' : ''}¥${Math.abs(rounded).toLocaleString()}`;
};

const REMOVE_COLOUR = '#ff3333';

// 選択中列車の乗客数表示の更新間隔(ms)。sim層のpassengersは毎tick変化するが、
// Canvas外のDOM(GameUI)からは低頻度ポーリングで十分。
const PASSENGERS_POLL_INTERVAL_MS = 500;

interface GameUIProps {
  buildMode: CellType | 'none' | 'remove' | 'signal';
  setBuildMode: (mode: CellType | 'none' | 'remove' | 'signal') => void;
  selectedTrainId: string | null;
  trains: TrainData[];
  stations: Map<string, StationData>;
  isEditingSchedule: boolean;
  setIsEditingSchedule: (v: boolean) => void;
  onDeploy: (trainId: string) => void;
  // ★追加
  scheduleClipboard: string[] | null;
  onCopySchedule: (trainId: string) => void;
  onPasteSchedule: (trainId: string) => void;
  // ★追加: ゲーム内時計
  simSpeed: 0 | 1 | 2 | 4;
  setSimSpeed: (speed: 0 | 1 | 2 | 4) => void;
  // ★追加: セーブ／ロード
  onSave: () => void;
  onLoad: () => void;
  // ★追加: 経済システム
  money: number;
  world: React.RefObject<SimWorld>;
  // ★追加: 人身事故とホームドア
  selectedStationId: string | null;
  onUpgradeDoors: (stationId: string, doorType: PlatformDoorType) => void;
  accidents: AccidentNotice[];
  // ★追加: 月次収支台帳
  currentLedger: MonthlyLedger;
  ledgerHistory: MonthlyLedger[];
}

export const GameUI: React.FC<GameUIProps> = ({
  buildMode, setBuildMode,
  selectedTrainId, trains, stations,
  isEditingSchedule, setIsEditingSchedule,
  onDeploy,
  scheduleClipboard, onCopySchedule, onPasteSchedule,
  simSpeed, setSimSpeed,
  onSave, onLoad,
  money, world,
  selectedStationId, onUpgradeDoors, accidents,
  currentLedger, ledgerHistory,
}) => {
  // ゲーム内日付(sim層所有のclockから低頻度でポーリングする)
  const [gameDate, setGameDate] = useState({ year: 1, month: 1, day: 1 });
  const [isFinanceOpen, setIsFinanceOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      const elapsed = world.current?.clock?.elapsed ?? 0;
      setGameDate(clockToDate(elapsed));
    }, CLOCK_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [world]);

  // 選択中列車の乗客数(sim層所有のTrainRuntimeから低頻度でポーリングする)
  const [passengers, setPassengers] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (!selectedTrainId) {
        setPassengers(0);
        return;
      }
      const rt = world.current?.runtimes.get(selectedTrainId);
      setPassengers(rt ? rt.passengers : 0);
    }, PASSENGERS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedTrainId, world]);

  // 選択中駅の待ち人数(StationLabelと同様、低頻度でポーリングする)
  const [stationWaiting, setStationWaiting] = useState(0);
  // 選択中駅の立地需要係数(周辺の街から算出。waitingと同様に低頻度でポーリングする)
  const [stationDemand, setStationDemand] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (!selectedStationId) {
        setStationWaiting(0);
        setStationDemand(0);
        return;
      }
      const waiting = world.current?.waiting.get(selectedStationId) ?? 0;
      setStationWaiting(Math.floor(waiting));

      const station = stations.get(selectedStationId);
      const towns = world.current?.towns ?? [];
      setStationDemand(station ? demandFactor(station.center, towns) : 0);
    }, PASSENGERS_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [selectedStationId, world, stations]);

  const speedBtnStyle = (speed: 0 | 1 | 2 | 4) => ({
    padding: '8px 14px', fontSize: '14px', fontWeight: 'bold' as const, cursor: 'pointer',
    background: simSpeed === speed ? '#00aaff' : 'white',
    color: simSpeed === speed ? 'white' : 'black',
    border: '2px solid #00aaff', borderRadius: '8px'
  });
  const btnStyle = (mode: string, color: string) => ({
    padding: '10px 20px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer',
    background: buildMode === mode ? color : 'white',
    color: buildMode === mode ? 'white' : 'black',
    border: `2px solid ${color}`, borderRadius: '8px'
  });

  const selectedTrain = trains.find(t => t.id === selectedTrainId);
  const selectedStation = selectedStationId ? stations.get(selectedStationId) : undefined;

  return (
    <>
      {/* ★追加: 人身事故バナー */}
      {accidents.length > 0 && (
        <div style={{
          position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)',
          display: 'flex', flexDirection: 'column', gap: '6px', pointerEvents: 'none', zIndex: 20
        }}>
          {accidents.map((a, i) => {
            const st = stations.get(a.stationId);
            return (
              <div key={`${a.trainId}-${i}`} style={{
                background: '#cc0000', color: 'white', padding: '8px 16px', borderRadius: '6px',
                fontWeight: 'bold', fontSize: '0.9rem', boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
              }}>
                ⚠ {st ? st.name : a.stationId} で人身事故が発生 — 運転見合わせ中
              </div>
            );
          })}
        </div>
      )}

      <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', pointerEvents: 'auto', zIndex: 10 }}>
        <button onClick={() => setSimSpeed(0)} style={speedBtnStyle(0)} title="Pause">⏸</button>
        <button onClick={() => setSimSpeed(1)} style={speedBtnStyle(1)}>1x</button>
        <button onClick={() => setSimSpeed(2)} style={speedBtnStyle(2)}>2x</button>
        <button onClick={() => setSimSpeed(4)} style={speedBtnStyle(4)}>4x</button>
        <div style={{ width: '1px', background: '#ccc', margin: '0 4px' }} />
        <div style={{
          padding: '8px 14px', fontSize: '14px', fontWeight: 'bold',
          background: 'white', color: '#333', border: '2px solid #999', borderRadius: '8px',
          display: 'flex', alignItems: 'center'
        }}>
          {gameDate.year}年 {gameDate.month}月 {gameDate.day}日
        </div>
        <button
          onClick={() => setIsFinanceOpen(v => !v)}
          style={{
            padding: '8px 14px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer',
            background: isFinanceOpen ? '#00994d' : 'white', color: isFinanceOpen ? 'white' : 'black',
            border: '2px solid #00994d', borderRadius: '8px'
          }}
        >
          Finance
        </button>
        <button onClick={onSave} style={{ padding: '8px 14px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', background: 'white', color: 'black', border: '2px solid #00cc66', borderRadius: '8px' }}>Save</button>
        <button onClick={onLoad} style={{ padding: '8px 14px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', background: 'white', color: 'black', border: '2px solid #ffaa00', borderRadius: '8px' }}>Load</button>
      </div>

      {isFinanceOpen && (
        <div style={{
          position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(255,255,255,0.97)', borderRadius: '8px', padding: '1rem',
          fontFamily: 'sans-serif', pointerEvents: 'auto', zIndex: 10,
          boxShadow: '0 4px 6px rgba(0,0,0,0.15)', minWidth: '420px'
        }}>
          <h3 style={{ margin: '0 0 8px 0', fontSize: '1rem', color: '#333' }}>収支</h3>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ccc', textAlign: 'right' }}>
                <th style={{ textAlign: 'left', padding: '4px' }}>月</th>
                <th style={{ padding: '4px' }}>運賃収入</th>
                <th style={{ padding: '4px' }}>建設費</th>
                <th style={{ padding: '4px' }}>維持費</th>
                <th style={{ padding: '4px' }}>事故</th>
                <th style={{ padding: '4px' }}>損益</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #eee', textAlign: 'right', color: '#666' }}>
                <td style={{ textAlign: 'left', padding: '4px' }}>{currentLedger.year}年{currentLedger.month}月(進行中)</td>
                <td style={{ padding: '4px' }}>{formatSigned(currentLedger.fares)}</td>
                <td style={{ padding: '4px' }}>{formatSigned(currentLedger.construction)}</td>
                <td style={{ padding: '4px' }}>{formatSigned(currentLedger.upkeep)}</td>
                <td style={{ padding: '4px' }}>{formatSigned(currentLedger.accidents)}</td>
                <td style={{
                  padding: '4px',
                  color: currentLedger.fares - currentLedger.construction - currentLedger.upkeep - currentLedger.accidents >= 0 ? '#00994d' : '#cc0000',
                  fontWeight: 'bold'
                }}>
                  {formatSigned(currentLedger.fares - currentLedger.construction - currentLedger.upkeep - currentLedger.accidents)}
                </td>
              </tr>
              {[...ledgerHistory].reverse().map((l, i) => {
                const profit = l.fares - l.construction - l.upkeep - l.accidents;
                return (
                  <tr key={i} style={{ borderBottom: '1px solid #eee', textAlign: 'right' }}>
                    <td style={{ textAlign: 'left', padding: '4px' }}>{l.year}年{l.month}月</td>
                    <td style={{ padding: '4px' }}>{formatSigned(l.fares)}</td>
                    <td style={{ padding: '4px' }}>{formatSigned(l.construction)}</td>
                    <td style={{ padding: '4px' }}>{formatSigned(l.upkeep)}</td>
                    <td style={{ padding: '4px' }}>{formatSigned(l.accidents)}</td>
                    <td style={{ padding: '4px', color: profit >= 0 ? '#00994d' : '#cc0000', fontWeight: 'bold' }}>
                      {formatSigned(profit)}
                    </td>
                  </tr>
                );
              })}
              {ledgerHistory.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: '8px', textAlign: 'center', color: '#999', fontStyle: 'italic' }}>
                    確定済みの月次決算はまだありません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', pointerEvents: 'auto', zIndex: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button onClick={() => setBuildMode('none')} style={btnStyle('none', '#666')}>Select</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button onClick={() => setBuildMode('rail')} style={btnStyle('rail', '#00aaff')}>Rail</button>
          <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '2px' }}>{RAIL_COST}/cell</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button onClick={() => setBuildMode('station')} style={btnStyle('station', STATION_COLOUR)}>Station</button>
          <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '2px' }}>¥{STATION_COST.toLocaleString()}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button onClick={() => setBuildMode('depot')} style={btnStyle('depot', DEPOT_COLOUR)}>Depot</button>
          <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '2px' }}>¥{DEPOT_COST.toLocaleString()}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button onClick={() => setBuildMode('signal')} style={btnStyle('signal', SIGNAL_COLOUR)}>Signal</button>
          <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '2px' }}>¥{SIGNAL_COST.toLocaleString()}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <button onClick={() => setBuildMode('remove')} style={btnStyle('remove', REMOVE_COLOUR)}>Remove</button>
        </div>
      </div>

      <div style={{
        position: 'absolute', top: 20, left: 20, padding: '1rem',
        background: 'rgba(255,255,255,0.95)', borderRadius: '8px',
        fontFamily: 'sans-serif', pointerEvents: 'auto', userSelect: 'none',
        zIndex: 10, minWidth: '220px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
      }}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: '1.2rem', color: '#333' }}>CubicTransim</h2>
        <div style={{ margin: '0 0 10px 0', fontSize: '1.1rem', fontWeight: 'bold', color: money < 0 ? '#cc0000' : '#00994d' }}>
          {formatSigned(money)}
        </div>
        {selectedTrain ? (
          <div>
             <div style={{ borderBottom: '1px solid #ccc', paddingBottom: '5px', marginBottom: '10px' }}>
               <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#ff0055' }}>
                 Train {selectedTrain.id}
               </div>
               <div style={{ fontSize: '0.8rem', color: '#666' }}>
                 Status: <span style={{ fontWeight: 'bold', color: selectedTrain.status === 'running' ? '#00aaff' : '#999' }}>{selectedTrain.status.toUpperCase()}</span>
               </div>
               <div style={{ fontSize: '0.8rem', color: '#666' }}>
                 Passengers: <span style={{ fontWeight: 'bold' }}>{passengers}/{selectedTrain.cars * CAPACITY_PER_CAR}</span>
               </div>
             </div>

             {/* スケジュール表示 */}
             <div style={{ marginBottom: '10px' }}>
               <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                 <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>Schedule:</div>
                 {/* コピー＆ペーストボタン */}
                 <div style={{ display:'flex', gap:'5px' }}>
                   <button onClick={() => onCopySchedule(selectedTrain.id)} style={{ fontSize:'0.8rem', cursor:'pointer' }} title="Copy">📋</button>
                   {scheduleClipboard && (
                     <button onClick={() => onPasteSchedule(selectedTrain.id)} style={{ fontSize:'0.8rem', cursor:'pointer' }} title="Paste">📝</button>
                   )}
                 </div>
               </div>

               {selectedTrain.schedule.length === 0 ? (
                 <div style={{ fontSize: '0.8rem', color: '#999', fontStyle: 'italic', marginTop:'5px' }}>No stops</div>
               ) : (
                 <div style={{ maxHeight: '100px', overflowY: 'auto', fontSize: '0.85rem', marginTop:'5px' }}>
                   {selectedTrain.schedule.map((sid, idx) => {
                     const st = stations.get(sid);
                     const isNext = idx === selectedTrain.scheduleIndex;
                     return (
                       <div key={idx} style={{ 
                         padding: '2px 0', 
                         color: isNext ? '#00aaff' : '#333',
                         fontWeight: isNext ? 'bold' : 'normal'
                       }}>
                         {idx + 1}. {st ? st.name : sid} {isNext && '<<'}
                       </div>
                     );
                   })}
                 </div>
               )}
             </div>

             {selectedTrain.status === 'stored' && (
                 <button 
                   onClick={() => onDeploy(selectedTrain.id)}
                   style={{
                     width: '100%', padding: '8px', marginTop: '10px',
                     background: '#00cc66', border: '1px solid #ccc', borderRadius: '4px',
                     fontWeight: 'bold', cursor: 'pointer', color: 'white'
                   }}
                 >
                   Deploy Train
                 </button>
             )}

             <button 
               onClick={() => setIsEditingSchedule(!isEditingSchedule)}
               style={{
                 width: '100%', padding: '8px', marginTop: '5px',
                 background: isEditingSchedule ? '#ffaa00' : '#eee',
                 border: '1px solid #ccc', borderRadius: '4px',
                 fontWeight: 'bold', cursor: 'pointer',
                 color: isEditingSchedule ? 'white' : 'black'
               }}
             >
               {isEditingSchedule ? 'Finish Editing' : 'Edit Schedule'}
             </button>
             
             {isEditingSchedule && (
               <div style={{ fontSize: '0.8rem', color: '#ffaa00', marginTop: '5px', textAlign: 'center' }}>
                 Click stations to add stops
               </div>
             )}
          </div>
        ) : selectedStation ? (
          <div>
            <div style={{ borderBottom: '1px solid #ccc', paddingBottom: '5px', marginBottom: '10px' }}>
              <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: STATION_COLOUR }}>
                {selectedStation.name}
              </div>
              <div style={{ fontSize: '0.8rem', color: '#666' }}>
                Waiting: <span style={{ fontWeight: 'bold' }}>{stationWaiting}</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#666' }}>
                Demand: <span style={{ fontWeight: 'bold' }}>{stationDemand.toFixed(1)}x</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: '#666' }}>
                Platform doors: <span style={{ fontWeight: 'bold' }}>{selectedStation.platformDoors}</span>
              </div>
            </div>

            <button
              onClick={() => onUpgradeDoors(selectedStation.id, 'standard')}
              disabled={selectedStation.platformDoors !== 'none' || money < PLATFORM_DOOR_STANDARD_COST}
              style={{
                width: '100%', padding: '8px', marginBottom: '5px',
                background: selectedStation.platformDoors !== 'none' || money < PLATFORM_DOOR_STANDARD_COST ? '#eee' : '#00aaff',
                color: selectedStation.platformDoors !== 'none' || money < PLATFORM_DOOR_STANDARD_COST ? '#999' : 'white',
                border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'bold',
                cursor: selectedStation.platformDoors !== 'none' || money < PLATFORM_DOOR_STANDARD_COST ? 'not-allowed' : 'pointer'
              }}
            >
              標準ホームドア ¥{PLATFORM_DOOR_STANDARD_COST.toLocaleString()}
            </button>

            <button
              onClick={() => onUpgradeDoors(selectedStation.id, 'fullscreen')}
              disabled={selectedStation.platformDoors === 'fullscreen' || money < PLATFORM_DOOR_FULLSCREEN_COST}
              style={{
                width: '100%', padding: '8px',
                background: selectedStation.platformDoors === 'fullscreen' || money < PLATFORM_DOOR_FULLSCREEN_COST ? '#eee' : '#00cc66',
                color: selectedStation.platformDoors === 'fullscreen' || money < PLATFORM_DOOR_FULLSCREEN_COST ? '#999' : 'white',
                border: '1px solid #ccc', borderRadius: '4px', fontWeight: 'bold',
                cursor: selectedStation.platformDoors === 'fullscreen' || money < PLATFORM_DOOR_FULLSCREEN_COST ? 'not-allowed' : 'pointer'
              }}
            >
              フルスクリーン ¥{PLATFORM_DOOR_FULLSCREEN_COST.toLocaleString()}
            </button>
          </div>
        ) : (
           <div style={{ color: '#666', fontSize: '0.9rem' }}>
             Select a train or Depot to manage.
           </div>
        )}
      </div>
    </>
  );
};