// パーツ一覧(head/mid のうち選択中バリアント)。行の操作(表示切替・複製・削除・並べ替え)を
// TrainEditorApp から受け取ったコールバックへそのまま委譲する。
import React from 'react';
import { T } from '../../ui/theme';
import type { TrainPart } from '../../render/trainPartsSpec';

interface Props {
  parts: TrainPart[];
  hiddenIndices: ReadonlySet<number>;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onToggleVisible: (index: number) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
}

const rowStyle = (selected: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px',
  borderRadius: T.radiusSm,
  background: selected ? T.accentInk : 'transparent',
  border: selected ? `1px solid ${T.accent}` : '1px solid transparent',
  cursor: 'pointer',
  fontSize: 12,
});

const smallButton: React.CSSProperties = {
  background: 'transparent',
  border: `1px solid ${T.line}`,
  color: T.textMuted,
  borderRadius: T.radiusSm,
  fontSize: 11,
  lineHeight: 1,
  padding: '2px 5px',
  cursor: 'pointer',
};

const kindBadge: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 5px',
  borderRadius: T.radiusPill,
  background: T.inkSoft,
  color: T.textMuted,
  flexShrink: 0,
};

export const PartsList: React.FC<Props> = ({
  parts, hiddenIndices, selectedIndex, onSelect, onToggleVisible, onDuplicate, onDelete, onMove,
}) => {
  if (parts.length === 0) {
    return <div style={{ fontSize: 12, color: T.textFaint, padding: 8 }}>パーツがありません。</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {parts.map((part, index) => {
        const hidden = hiddenIndices.has(index);
        return (
          <div key={index} style={rowStyle(index === selectedIndex)} onClick={() => onSelect(index)}>
            <button
              style={smallButton}
              title={hidden ? '表示する' : '非表示にする'}
              onClick={e => { e.stopPropagation(); onToggleVisible(index); }}
            >
              {hidden ? '🚫' : '👁'}
            </button>
            <span style={kindBadge}>{part.kind}</span>
            <span style={{ flex: 1, color: hidden ? T.textFaint : T.text, opacity: hidden ? 0.5 : 1 }}>
              {part.label || `(無題 ${index})`}
            </span>
            <button style={smallButton} title="上へ" onClick={e => { e.stopPropagation(); onMove(index, -1); }} disabled={index === 0}>↑</button>
            <button style={smallButton} title="下へ" onClick={e => { e.stopPropagation(); onMove(index, 1); }} disabled={index === parts.length - 1}>↓</button>
            <button style={smallButton} title="複製" onClick={e => { e.stopPropagation(); onDuplicate(index); }}>⧉</button>
            <button style={smallButton} title="削除" onClick={e => { e.stopPropagation(); onDelete(index); }}>✕</button>
          </div>
        );
      })}
    </div>
  );
};
