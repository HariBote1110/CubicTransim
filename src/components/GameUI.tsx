import React, { useEffect, useState } from 'react';
import { STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellType, TrainData, StationData } from '../types';
import { RAIL_COST, STATION_COST, DEPOT_COST, SIGNAL_COST, TRAIN_CAPACITY } from '../sim/economy';
import type { SimWorld } from '../sim/simulation';

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
}

export const GameUI: React.FC<GameUIProps> = ({
  buildMode, setBuildMode,
  selectedTrainId, trains, stations,
  isEditingSchedule, setIsEditingSchedule,
  onDeploy,
  scheduleClipboard, onCopySchedule, onPasteSchedule,
  simSpeed, setSimSpeed,
  onSave, onLoad,
  money, world
}) => {
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

  return (
    <>
      <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', pointerEvents: 'auto', zIndex: 10 }}>
        <button onClick={() => setSimSpeed(0)} style={speedBtnStyle(0)} title="Pause">⏸</button>
        <button onClick={() => setSimSpeed(1)} style={speedBtnStyle(1)}>1x</button>
        <button onClick={() => setSimSpeed(2)} style={speedBtnStyle(2)}>2x</button>
        <button onClick={() => setSimSpeed(4)} style={speedBtnStyle(4)}>4x</button>
        <div style={{ width: '1px', background: '#ccc', margin: '0 4px' }} />
        <button onClick={onSave} style={{ padding: '8px 14px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', background: 'white', color: 'black', border: '2px solid #00cc66', borderRadius: '8px' }}>Save</button>
        <button onClick={onLoad} style={{ padding: '8px 14px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer', background: 'white', color: 'black', border: '2px solid #ffaa00', borderRadius: '8px' }}>Load</button>
      </div>

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
        <div style={{ margin: '0 0 10px 0', fontSize: '1.1rem', fontWeight: 'bold', color: '#00994d' }}>
          ¥{Math.floor(money).toLocaleString()}
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
                 Passengers: <span style={{ fontWeight: 'bold' }}>{passengers}/{TRAIN_CAPACITY}</span>
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
        ) : (
           <div style={{ color: '#666', fontSize: '0.9rem' }}>
             Select a train or Depot to manage.
           </div>
        )}
      </div>
    </>
  );
};