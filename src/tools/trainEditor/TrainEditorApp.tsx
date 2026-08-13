// 列車外観エディタ(Phase B)のトップレベル。ゲーム本体の描画パイプライン
// (WebGpuTerrainLayerController)をそのまま使い、車種ごとの MODEL_PARTS を
// 編集・プレビューする。永続化は無いワンオフツールで、成果物はJSON書き出しのみ
// (progress/train-editor-tool.md 参照。MODEL_PARTS への貼り込みは手動運用)。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { T, button as themeButton } from '../../ui/theme';
import { TRAIN_MODELS, type TrainModelId } from '../../sim/physics';
import { MODEL_PARTS } from '../../render/trainMeshBuilder';
import { validateParts, type TrainPart, type TrainCarParts } from '../../render/trainPartsSpec';
import { UNAVAILABLE_MESSAGE, type WebGpuUnavailableError } from '../../render/webgpuLayer';
import { TrainEditorPreview } from './previewController';
import { PartsList } from './PartsList';
import { PartInspector } from './PartInspector';

const MODEL_IDS: readonly TrainModelId[] = ['commuter', 'suburban', 'express', 'local-express'];
type Variant = 'head' | 'mid';

const deepClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const DEFAULT_PART_BY_KIND: Record<TrainPart['kind'], TrainPart> = {
  box: { kind: 'box', size: [0.1, 0.1, 0.1], pos: [0, 0, 0], colour: '#8899aa', label: '新規パーツ' },
  wedge: { kind: 'wedge', size: [0.2, 0.1, 0.1], pos: [0, 0, 0], colour: '#8899aa', label: '新規パーツ' },
  cylinder: { kind: 'cylinder', size: [0.05, 0.1, 0.05], pos: [0, 0, 0], colour: '#8899aa', label: '新規パーツ' },
  cone: { kind: 'cone', size: [0.05, 0.1, 0], pos: [0, 0, 0], colour: '#8899aa', label: '新規パーツ' },
};

/** JSON入力が TrainCarParts の形をしているかどうかを緩く検査する。 */
function isValidTrainCarParts(value: unknown): value is TrainCarParts {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const isPartArray = (arr: unknown): boolean =>
    Array.isArray(arr) && arr.every(p =>
      p && typeof p === 'object' &&
      typeof (p as TrainPart).kind === 'string' &&
      Array.isArray((p as TrainPart).size) && (p as TrainPart).size.length === 3 &&
      Array.isArray((p as TrainPart).pos) && (p as TrainPart).pos.length === 3 &&
      typeof (p as TrainPart).colour === 'string',
    );
  return isPartArray(v.head) && isPartArray(v.mid);
}

const panelStyle: React.CSSProperties = {
  background: T.ink,
  border: `1px solid ${T.line}`,
  borderRadius: T.radius,
  padding: T.pad,
  boxShadow: T.shadowSm,
  color: T.text,
};

export const TrainEditorApp: React.FC = () => {
  const [modelId, setModelId] = useState<TrainModelId>('commuter');
  const [variant, setVariant] = useState<Variant>('head');
  const [doc, setDoc] = useState<TrainCarParts>(() => deepClone(MODEL_PARTS.commuter));
  const [hidden, setHidden] = useState<Record<Variant, Set<number>>>({ head: new Set(), mid: new Set() });
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [lineColour, setLineColour] = useState('#38b6ff');
  const [zoom, setZoom] = useState(220);
  const [panX, setPanX] = useState(0);
  const [panZ, setPanZ] = useState(0);
  const [yawDeg, setYawDeg] = useState(30);
  const [jsonText, setJsonText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<TrainEditorPreview | null>(null);

  // カメラ・路線色・yawはRAFループから毎フレーム参照するのでrefにも複製する
  // (Stateの再バインドを待たずに次フレームへ反映するため)。
  const liveRef = useRef({ lineColour, zoom, panX, panZ, yawDeg });
  liveRef.current = { lineColour, zoom, panX, panZ, yawDeg };

  const parts = variant === 'head' ? doc.head : doc.mid;
  const hiddenSet = hidden[variant];
  const selectedPart = selectedIndex !== null ? parts[selectedIndex] ?? null : null;

  const warnings = useMemo(() => {
    const visible = parts.filter((_, i) => !hiddenSet.has(i));
    return validateParts(visible);
  }, [parts, hiddenSet]);

  // --- モデル切り替え ---
  const handleModelChange = (id: TrainModelId): void => {
    setModelId(id);
    setDoc(deepClone(MODEL_PARTS[id]));
    setHidden({ head: new Set(), mid: new Set() });
    setSelectedIndex(null);
  };

  // --- パーツ編集操作 ---
  const updateVariantParts = useCallback((updater: (list: TrainPart[]) => TrainPart[]): void => {
    setDoc(prev => ({ ...prev, [variant]: updater(prev[variant]) }));
  }, [variant]);

  const handlePartChange = (index: number, next: TrainPart): void => {
    updateVariantParts(list => list.map((p, i) => (i === index ? next : p)));
  };
  const handleToggleVisible = (index: number): void => {
    setHidden(prev => {
      const next = new Set(prev[variant]);
      if (next.has(index)) next.delete(index); else next.add(index);
      return { ...prev, [variant]: next };
    });
  };
  const handleDuplicate = (index: number): void => {
    updateVariantParts(list => {
      const copy = deepClone(list[index]);
      return [...list.slice(0, index + 1), copy, ...list.slice(index + 1)];
    });
  };
  const handleDelete = (index: number): void => {
    updateVariantParts(list => list.filter((_, i) => i !== index));
    setSelectedIndex(null);
  };
  const handleMove = (index: number, delta: -1 | 1): void => {
    updateVariantParts(list => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setSelectedIndex(index + delta);
  };
  const handleAddPart = (kind: TrainPart['kind']): void => {
    updateVariantParts(list => [...list, deepClone(DEFAULT_PART_BY_KIND[kind])]);
    setSelectedIndex(parts.length);
  };

  // --- Export / Import ---
  const handleCopyJson = async (): Promise<void> => {
    const text = JSON.stringify(doc, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('コピーしました');
    } catch {
      setCopyStatus('コピーに失敗しました(ブラウザの権限を確認してください)');
    }
    setTimeout(() => setCopyStatus(null), 2500);
  };
  const handleDownloadJson = (): void => {
    const text = JSON.stringify(doc, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${modelId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleApplyImport = (): void => {
    setImportError(null);
    try {
      const parsed = JSON.parse(jsonText);
      if (!isValidTrainCarParts(parsed)) {
        setImportError('JSONの形式が不正です(head/midがTrainPart配列ではありません)。');
        return;
      }
      setDoc(parsed);
      setHidden({ head: new Set(), mid: new Set() });
      setSelectedIndex(null);
    } catch (e) {
      setImportError(`JSONの解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const handleImportFile = (file: File): void => {
    file.text().then(text => setJsonText(text)).catch(() => setImportError('ファイルの読み込みに失敗しました。'));
  };

  // --- プレビュー初期化(WebGPU) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let rafId = 0;

    TrainEditorPreview.create(canvas).then(preview => {
      if (cancelled) { return; }
      previewRef.current = preview;
      const loop = (): void => {
        const live = liveRef.current;
        preview.updateInstances(live.lineColour, live.yawDeg);
        preview.render({ centreX: live.panX, centreZ: live.panZ, pixelsPerUnit: live.zoom });
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    }).catch((error: WebGpuUnavailableError | Error) => {
      if (cancelled) return;
      const message = 'reason' in error ? UNAVAILABLE_MESSAGE[error.reason] : error.message;
      setPreviewError(message);
    });

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, []);

  // --- パーツ変更をプレビューへ反映(デバウンス) ---
  useEffect(() => {
    const timer = setTimeout(() => {
      const preview = previewRef.current;
      if (!preview) return;
      const visibleHead = doc.head.filter((_, i) => !hidden.head.has(i));
      const visibleMid = doc.mid.filter((_, i) => !hidden.mid.has(i));
      preview.updateParts({ head: visibleHead, mid: visibleMid });
    }, 100);
    return () => clearTimeout(timer);
  }, [doc, hidden]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', background: '#0a0e14', fontFamily: 'system-ui, sans-serif' }}>
      {/* 左ペイン: モデル選択・プレビュー */}
      <div style={{ flex: '1 1 60%', display: 'flex', flexDirection: 'column', padding: 12, gap: 10, minWidth: 0 }}>
        <div style={{ ...panelStyle, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>列車外観エディタ</strong>
          <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
            {MODEL_IDS.map(id => (
              <button
                key={id}
                style={themeButton({ active: id === modelId, compact: true })}
                onClick={() => handleModelChange(id)}
              >
                {TRAIN_MODELS[id].name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, marginLeft: 12 }}>
            {(['head', 'mid'] as Variant[]).map(v => (
              <button
                key={v}
                style={themeButton({ active: v === variant, compact: true })}
                onClick={() => { setVariant(v); setSelectedIndex(null); }}
              >
                {v === 'head' ? '先頭車' : '中間車'}
              </button>
            ))}
          </div>
        </div>

        <div style={{ ...panelStyle, flex: 1, position: 'relative', minHeight: 0, padding: 0, overflow: 'hidden' }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          {previewError && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(10,14,20,0.9)', color: T.warning, fontSize: 13, padding: 24, textAlign: 'center',
            }}>
              {previewError}
            </div>
          )}
        </div>

        <div style={{ ...panelStyle, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            ズーム
            <input type="range" min={80} max={500} value={zoom} onChange={e => setZoom(e.target.valueAsNumber)} />
            <span style={{ color: T.textMuted }}>{zoom}px/u</span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            回転
            <input type="range" min={0} max={360} value={yawDeg} onChange={e => setYawDeg(e.target.valueAsNumber)} />
            <span style={{ color: T.textMuted }}>{yawDeg}°</span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            X
            <input type="range" min={-3} max={3} step={0.1} value={panX} onChange={e => setPanX(e.target.valueAsNumber)} />
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            Z
            <input type="range" min={-3} max={3} step={0.1} value={panZ} onChange={e => setPanZ(e.target.valueAsNumber)} />
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            路線色
            <input type="color" value={lineColour} onChange={e => setLineColour(e.target.value)} />
          </label>
        </div>
      </div>

      {/* 右ペイン: パーツ一覧・インスペクタ・JSON入出力 */}
      <div style={{ flex: '0 0 380px', display: 'flex', flexDirection: 'column', gap: 10, padding: 12, paddingLeft: 0, overflowY: 'auto' }}>
        {warnings.length > 0 && (
          <div style={{ ...panelStyle, borderColor: T.warning, fontSize: 12, color: T.warning }}>
            {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
          </div>
        )}

        <div style={panelStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 12 }}>パーツ一覧({variant === 'head' ? '先頭車' : '中間車'})</strong>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['box', 'wedge', 'cylinder', 'cone'] as TrainPart['kind'][]).map(k => (
                <button key={k} style={themeButton({ compact: true })} onClick={() => handleAddPart(k)}>
                  ＋{k}
                </button>
              ))}
            </div>
          </div>
          <PartsList
            parts={parts}
            hiddenIndices={hiddenSet}
            selectedIndex={selectedIndex}
            onSelect={setSelectedIndex}
            onToggleVisible={handleToggleVisible}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onMove={handleMove}
          />
        </div>

        {selectedPart && (
          <div style={panelStyle}>
            <strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>パーツ編集</strong>
            <PartInspector part={selectedPart} onChange={next => handlePartChange(selectedIndex!, next)} />
          </div>
        )}

        <div style={panelStyle}>
          <strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>JSON入出力</strong>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button style={themeButton({ compact: true })} onClick={handleCopyJson}>JSONをコピー</button>
            <button style={themeButton({ compact: true })} onClick={handleDownloadJson}>JSONを書き出し</button>
          </div>
          {copyStatus && <div style={{ fontSize: 11, color: T.positive, marginBottom: 6 }}>{copyStatus}</div>}
          <textarea
            value={jsonText}
            onChange={e => setJsonText(e.target.value)}
            placeholder="ここにJSONを貼り付けて「適用」"
            style={{
              width: '100%', height: 120, boxSizing: 'border-box', background: T.inkSoft,
              border: `1px solid ${T.line}`, borderRadius: T.radiusSm, color: T.text, fontSize: 11, fontFamily: 'monospace',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
            <input type="file" accept="application/json" onChange={e => { const f = e.target.files?.[0]; if (f) handleImportFile(f); }} style={{ fontSize: 11 }} />
            <button style={themeButton({ compact: true })} onClick={handleApplyImport}>適用</button>
          </div>
          {importError && <div style={{ fontSize: 11, color: T.danger, marginTop: 6 }}>{importError}</div>}
          <div style={{ fontSize: 11, color: T.textFaint, marginTop: 8, lineHeight: 1.5 }}>
            エクスポートしたJSONを render/trainMeshBuilder.ts の MODEL_PARTS に貼り込む運用です
            (このツールから自動で書き込むことはありません)。
          </div>
        </div>
      </div>
    </div>
  );
};
