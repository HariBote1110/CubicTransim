import React from 'react';
import { STATION_COLOUR, DEPOT_COLOUR, SIGNAL_COLOUR } from '../types';
import type { CellType, TrainData, StationData } from '../types';

const REMOVE_COLOUR = '#ff3333';

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
}

export const GameUI: React.FC<GameUIProps> = ({ 
  buildMode, setBuildMode, 
  selectedTrainId, trains, stations, 
  isEditingSchedule, setIsEditingSchedule,
  onDeploy,
  scheduleClipboard, onCopySchedule, onPasteSchedule
}) => {
  const btnStyle = (mode: string, color: string) => ({
    padding: '10px 20px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer',
    background: buildMode === mode ? color : 'white',
    color: buildMode === mode ? 'white' : 'black',
    border: `2px solid ${color}`, borderRadius: '8px'
  });

  const selectedTrain = trains.find(t => t.id === selectedTrainId);

  return (
    <>
      <div style={{ position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '10px', pointerEvents: 'auto', zIndex: 10 }}>
        <button onClick={() => setBuildMode('none')} style={btnStyle('none', '#666')}>Select</button>
        <button onClick={() => setBuildMode('rail')} style={btnStyle('rail', '#00aaff')}>Rail</button>
        <button onClick={() => setBuildMode('station')} style={btnStyle('station', STATION_COLOUR)}>Station</button>
        <button onClick={() => setBuildMode('depot')} style={btnStyle('depot', DEPOT_COLOUR)}>Depot</button>
        <button onClick={() => setBuildMode('signal')} style={btnStyle('signal', SIGNAL_COLOUR)}>Signal</button>
        <button onClick={() => setBuildMode('remove')} style={btnStyle('remove', REMOVE_COLOUR)}>Remove</button>
      </div>

      <div style={{ 
        position: 'absolute', top: 20, left: 20, padding: '1rem', 
        background: 'rgba(255,255,255,0.95)', borderRadius: '8px', 
        fontFamily: 'sans-serif', pointerEvents: 'auto', userSelect: 'none', 
        zIndex: 10, minWidth: '220px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
      }}>
        <h2 style={{ margin: '0 0 10px 0', fontSize: '1.2rem', color: '#333' }}>CubicTransim</h2>
        {selectedTrain ? (
          <div>
             <div style={{ borderBottom: '1px solid #ccc', paddingBottom: '5px', marginBottom: '10px' }}>
               <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#ff0055' }}>
                 Train {selectedTrain.id}
               </div>
               <div style={{ fontSize: '0.8rem', color: '#666' }}>
                 Status: <span style={{ fontWeight: 'bold', color: selectedTrain.status === 'running' ? '#00aaff' : '#999' }}>{selectedTrain.status.toUpperCase()}</span>
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