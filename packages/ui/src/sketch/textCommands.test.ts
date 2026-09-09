import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateExpression, expressionValueFromNumber as num } from '@pointercad/expression';
import { createEmptySketchDocument, WORK_PLANES } from '@pointercad/model';
import type { OutlinedText } from '@pointercad/drawing';
import { drawingFont } from '../drawing/drawingFont.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { applySketchText, commitSketchText, type SketchTextInput } from './textCommands.js';

vi.mock('../drawing/drawingFont.js', () => ({ drawingFont: { load: vi.fn(), outline: vi.fn() } }));
const state = () => useAppStore.getState();
const outline = (): OutlinedText => ({ status: 'ready', missingCharacters: [], fillRule: 'nonzero',
  metrics: { fontId: 'test', sizeMm: 1, advanceMm: 2, inkBounds: { left: 0, right: 1, bottom: 0, top: 1 } },
  subpaths: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [1, 0] },
    { kind: 'L', to: [1, 1] }, { kind: 'L', to: [0, 1] }, { kind: 'Z' }] }] });
const input: SketchTextInput = { text: '日', heightSource: '10', angleSource: '0', align: 'start', origin: [0, 0, 0], plane: WORK_PLANES.xy };
const pureInput = { text: '日', height: num(10), angleDegrees: 0, align: 'start' as const,
  origin: [num(0), num(0), num(0)] as const, plane: WORK_PLANES.xy, outlineText: outline };

describe('文字入力からスケッチへの一括確定(P8-52)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState()); state().setActiveTool('text');
    vi.mocked(drawingFont.load).mockReset(); vi.mocked(drawingFont.outline).mockReset();
    vi.mocked(drawingFont.load).mockResolvedValue('ready'); vi.mocked(drawingFont.outline).mockImplementation(outline);
  });
  it('複数の輪郭線をUndo一回で戻す', async () => {
    const before = state().sketch; expect(await applySketchText(input)).toBe(true);
    expect(state().sketch.features).toHaveLength(4); expect(state().activeTool).toBe('select');
    state().undo(); expect(state().sketch).toEqual(before); state().redo(); expect(state().sketch.features).toHaveLength(4);
  });
  it('繰り返しても既存のフィーチャーIDと衝突しない', () => {
    const first = commitSketchText(createEmptySketchDocument(), pureInput); if (!first.ok) throw new Error(first.reason);
    const second = commitSketchText(first.document, pureInput); if (!second.ok) throw new Error(second.reason);
    expect(second.document.features).toHaveLength(8);
    expect(new Set(second.document.features.map((feature) => feature.id)).size).toBe(8);
  });
  it('inchの高さ1と90度を別々の単位として扱う', async () => {
    state().setDisplaySettings({ ...state().displaySettings, lengthUnit: 'inch' });
    expect(await applySketchText({ ...input, heightSource: '1', angleSource: '90' })).toBe(true);
    const line = state().sketch.features[0];
    if (line.kind !== 'line' || line.to.mode !== 'absolute') throw new Error('文字の最初の辺が無い');
    expect(line.to.x.value).toBeCloseTo(0, 10); expect(line.to.y.value).toBeCloseTo(25.4, 10);
  });
  it('inchでもmmパラメータへ二重換算せず、高さ変更の式を保つ', async () => {
    state().applyDocument({ ...state().document, parameters: [{ name: '文字高さ', value: num(25.4), unit: 'mm', description: '' }] });
    state().setDisplaySettings({ ...state().displaySettings, lengthUnit: 'inch' });
    state().setActiveTool('text');
    expect(await applySketchText({ ...input, heightSource: '文字高さ + 1' })).toBe(true);
    const line = state().sketch.features[0];
    if (line.kind !== 'line' || line.to.mode !== 'absolute') throw new Error('文字の最初の辺が無い');
    expect(line.to.x.value).toBeCloseTo(50.8, 10);
    const reevaluated = evaluateExpression(line.to.x.source, { variables: new Map([['文字高さ', 50.8]]) });
    expect(reevaluated.ok).toBe(true);
    if (reevaluated.ok) expect(reevaluated.value.value).toBeCloseTo(76.2, 10);
  });
  it.each(['', '  ', 'a'.repeat(1001)])('空または長すぎる文字を断る', (text) => {
    expect(commitSketchText(createEmptySketchDocument(), { ...pureInput, text }).ok).toBe(false);
  });
  it.each(['0', '-1', 'bad()', '1/0'])('高さ%sは部分的な図形を残さない', async (heightSource) => {
    expect(await applySketchText({ ...input, heightSource })).toBe(false); expect(state().sketch.features).toHaveLength(0);
    expect(drawingFont.load).not.toHaveBeenCalled(); expect(state().shapeErrorMessage).not.toBeNull();
  });
  it('字体が読めなければ輪郭を作らず理由を示す', async () => {
    vi.mocked(drawingFont.load).mockResolvedValue('failed');
    expect(await applySketchText(input)).toBe(false); expect(state().sketch.features).toHaveLength(0);
    expect(state().shapeErrorMessage).not.toBeNull();
  });
  it('必要な字形がなければ代替の四角を作らない', async () => {
    vi.mocked(drawingFont.outline).mockReturnValue({ ...outline(), status: 'missingGlyph', metrics: null });
    expect(await applySketchText(input)).toBe(false); expect(state().sketch.features).toHaveLength(0);
  });
  it.each(['document', 'sketch', 'plane', 'tool'] as const)('字体待ちの%s切替へ古い輪郭を追加しない', async (change) => {
    let finish: (value: 'ready') => void = () => { throw new Error('未開始'); };
    vi.mocked(drawingFont.load).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = applySketchText(input);
    if (change === 'document') useAppStore.setState(createInitialDocumentState());
    if (change === 'sketch') useAppStore.setState({ sketch: { ...state().sketch, id: 'other-sketch' } });
    if (change === 'plane') useAppStore.setState({ workPlaneId: 'yz' });
    if (change === 'tool') state().setActiveTool('line');
    const next = state().sketch; finish('ready'); expect(await pending).toBe(false); expect(state().sketch).toBe(next);
  });
  it('字体の失敗も取消後の道具へエラーを持ち越さない', async () => {
    let fail: (error: Error) => void = () => { throw new Error('未開始'); };
    vi.mocked(drawingFont.load).mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    const pending = applySketchText(input); state().setActiveTool('line'); state().setShapeError(null);
    fail(new Error('font failed')); expect(await pending).toBe(false); expect(state().shapeErrorMessage).toBeNull();
  });
});
