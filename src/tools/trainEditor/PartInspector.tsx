// 選択中パーツの詳細編集フォーム。rot は UI 上は度数で扱い、データ(ラジアン)への変換を
// ここに閉じ込める(TrainPart.rot はラジアン、trainPartsSpec.ts の規約どおり)。
import React from 'react';
import { T } from '../../ui/theme';
import type { TrainPart, TrainPartKind } from '../../render/trainPartsSpec';

interface Props {
  part: TrainPart;
  onChange: (next: TrainPart) => void;
}

const RAD_PER_DEG = Math.PI / 180;
const KINDS: TrainPartKind[] = ['box', 'wedge', 'cylinder', 'cone'];

const label: React.CSSProperties = { fontSize: 11, color: T.textMuted, marginBottom: 2 };
const field: React.CSSProperties = {
  background: T.inkSoft, border: `1px solid ${T.line}`, borderRadius: T.radiusSm,
  color: T.text, fontSize: 12, padding: '3px 5px', width: '100%', boxSizing: 'border-box',
};
const row: React.CSSProperties = { display: 'flex', gap: 6, marginBottom: 8 };
const col: React.CSSProperties = { flex: 1 };
const section: React.CSSProperties = { marginBottom: 8 };

/** kindごとの3つの数値フィールドの見出し(sizeの意味論、trainPartsSpec.tsのコメント参照)。 */
const sizeLabels: Record<TrainPartKind, [string, string, string]> = {
  box: ['幅X', '高さY', '奥行きZ'],
  wedge: ['幅X', '高さY', '奥行きZ'],
  cylinder: ['半径(上)', '高さ', '半径(下)'],
  cone: ['半径', '高さ', '(未使用)'],
};

const NumberField: React.FC<{ label: string; value: number; step: number; onChange: (v: number) => void }> = (
  { label: text, value, step, onChange },
) => (
  <div style={col}>
    <div style={label}>{text}</div>
    <input
      style={field}
      type="number"
      step={step}
      value={Number.isFinite(value) ? value : 0}
      onChange={e => onChange(e.target.valueAsNumber || 0)}
    />
  </div>
);

export const PartInspector: React.FC<Props> = ({ part, onChange }) => {
  const [rx, ry, rz] = part.rot ?? [0, 0, 0];
  const rotDeg: [number, number, number] = [rx / RAD_PER_DEG, ry / RAD_PER_DEG, rz / RAD_PER_DEG];

  const setSize = (i: 0 | 1 | 2, v: number): void => {
    const size: [number, number, number] = [...part.size];
    size[i] = v;
    onChange({ ...part, size });
  };
  const setPos = (i: 0 | 1 | 2, v: number): void => {
    const pos: [number, number, number] = [...part.pos];
    pos[i] = v;
    onChange({ ...part, pos });
  };
  const setRotDeg = (i: 0 | 1 | 2, v: number): void => {
    const deg: [number, number, number] = [...rotDeg];
    deg[i] = v;
    const rad: [number, number, number] = [deg[0] * RAD_PER_DEG, deg[1] * RAD_PER_DEG, deg[2] * RAD_PER_DEG];
    onChange({ ...part, rot: rad[0] || rad[1] || rad[2] ? rad : undefined });
  };

  return (
    <div>
      <div style={section}>
        <div style={label}>ラベル</div>
        <input
          style={field}
          type="text"
          value={part.label ?? ''}
          onChange={e => onChange({ ...part, label: e.target.value })}
        />
      </div>

      <div style={section}>
        <div style={label}>種類</div>
        <select
          style={field}
          value={part.kind}
          onChange={e => onChange({ ...part, kind: e.target.value as TrainPartKind })}
        >
          {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>

      <div style={row}>
        {sizeLabels[part.kind].map((text, i) => (
          <NumberField key={i} label={`size.${text}`} value={part.size[i]} step={0.005} onChange={v => setSize(i as 0 | 1 | 2, v)} />
        ))}
      </div>

      <div style={row}>
        {(['pos.X', 'pos.Y', 'pos.Z'] as const).map((text, i) => (
          <NumberField key={text} label={text} value={part.pos[i]} step={0.005} onChange={v => setPos(i as 0 | 1 | 2, v)} />
        ))}
      </div>

      <div style={row}>
        {(['rot.X(°)', 'rot.Y(°)', 'rot.Z(°)'] as const).map((text, i) => (
          <NumberField key={text} label={text} value={rotDeg[i]} step={1} onChange={v => setRotDeg(i as 0 | 1 | 2, v)} />
        ))}
      </div>

      <div style={row}>
        <div style={col}>
          <div style={label}>色</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              type="color"
              value={part.colour}
              onChange={e => onChange({ ...part, colour: e.target.value })}
              style={{ width: 32, height: 26, padding: 0, border: `1px solid ${T.line}`, borderRadius: T.radiusSm, background: 'none' }}
            />
            <input
              style={field}
              type="text"
              value={part.colour}
              onChange={e => onChange({ ...part, colour: e.target.value })}
            />
          </div>
        </div>
        <div style={{ ...col, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <label style={{ fontSize: 12, color: T.text, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input
              type="checkbox"
              checked={part.tint ?? false}
              onChange={e => onChange({ ...part, tint: e.target.checked })}
            />
            路線色でtint
          </label>
        </div>
      </div>
    </div>
  );
};
