import { beforeEach, describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument, createAssemblyDocument, createDrawingDocument, type Parameter, type StrengthQuantityKind } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { calculateStrengthSession, createStrengthSession, editStrengthSession, evaluateStrengthSession, strengthSessionArea, strengthUsesCustomValues } from './strengthSession.js';
import { strengthResultRows } from './strengthResultView.js';
import { strengthExpressionField } from './strengthFields.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore, partWithPoint, extrudeFeature } from '../store/testing/createTestStore.js';

describe('簡易強度計算の入力・結果・材料条件', () => {
  it.each([
    ['force', 'force', '1mm', 'strength.field.force'],
    ['torque', 'torque', '1N', 'strength.field.torque'],
    ['youngModulus', 'stress', '90°', 'strength.field.youngModulus'],
  ] satisfies readonly (readonly [string, StrengthQuantityKind, string, MessageKey])[])('%sは異なる物理量を入力欄で拒否する', (name, quantity, source, label) => {
    const field = strengthExpressionField(createStrengthSession('mm'), [], name, quantity, label, source);
    expect(field.result.error).not.toBeNull(); expect(field.result.value).toBeNull();
    expect(field.field.source).toBe(source);
  });
  it('計算に失敗しても以前の結果を消さず、直すべき入力へ焦点を移す', () => {
    const previous = calculateStrengthSession(createStrengthSession('mm'), []);
    const invalid = editStrengthSession(previous, { kind: 'source', field: 'force', source: '1/0' });
    const retained = calculateStrengthSession(invalid, []);
    expect(retained.result).toBe(previous.result); expect(retained.focusedField).toBe('force');
    expect(retained.edited).toBe(true);
  });
  it('A5052の板厚を確認してもEは自動補完せず、利用者入力として記録する', () => {
    let session = editStrengthSession(createStrengthSession('mm'), { kind: 'material', id: 'a5052p-h34-0.2-1.3' });
    session = editStrengthSession(session, { kind: 'product-thickness', source: '1mm' });
    expect(session.sources.get('youngModulus')).toBe(''); expect(session.sources.get('shearModulus')).toBe('');
    expect(evaluateStrengthSession(session, [])).toMatchObject({ ok: false, field: 'youngModulus' });
    session = editStrengthSession(session, { kind: 'source', field: 'youngModulus', source: '70000' });
    const calculated = calculateStrengthSession(session, []);
    expect(calculated.result?.materialValuesEdited).toBe(true);
    expect(calculated.result?.value.inputs.get('yieldStress')?.canonical.value).toBe(180);
  });
  it('指定安全率の変更は余裕率に反映し、実際の安全率と変形は変えない', () => {
    const first = calculateStrengthSession(createStrengthSession('mm'), []);
    const next = calculateStrengthSession(editStrengthSession(first, { kind: 'source', field: 'safetyFactor', source: '3/2' }), []);
    expect(next.result?.value.results.get('reserveFactor')?.value).toBe((first.result?.value.results.get('reserveFactor')?.value ?? 0) * 2);
    expect(next.result?.value.results.get('actualSafetyFactor')).toEqual(first.result?.value.results.get('actualSafetyFactor'));
    expect(next.result?.value.results.get('deflection')).toEqual(first.result?.value.results.get('deflection'));
  });
  it('応力・力・トルクの単位札と評価値が表示単位inchでも変わらない', () => {
    const session = createStrengthSession('inch');
    const force = strengthExpressionField(session, [], 'force', 'force', 'strength.field.force', '0.1kN');
    const modulus = strengthExpressionField(session, [], 'youngModulus', 'stress', 'strength.field.youngModulus', '205GPa');
    const torque = strengthExpressionField(session, [], 'torque', 'torque', 'strength.field.torque', '2N*m');
    expect(force.field.unit).toBe('N'); expect(force.result.value?.value).toBe(100);
    expect(modulus.field.unit).toBe('MPa'); expect(modulus.result.value?.value).toBe(205000);
    expect(torque.field.unit).toBe('Nmm'); expect(torque.result.value?.value).toBe(2000);
  });
  it('起動時の単位がinchでも初期寸法は10mmを保ち、式欄の表示だけ換算する', () => {
    const session = createStrengthSession('inch');
    const outcome = evaluateStrengthSession(session, []);
    expect(outcome.ok && outcome.value.results.get('stress')?.value).toBe(6);
    const field = strengthExpressionField(session, [], 'width', 'length', 'strength.field.width', '1/2');
    expect(field.result.value?.value).toBe(12.7);
    expect(field.field.source).toBe('1/2');
  });
  it('SUS304へ切替時に鋼のGを残さず、入力するまで軸計算を許さない', () => {
    let session = editStrengthSession(createStrengthSession('mm'), { kind: 'calculation', calculation: { kind: 'shaft' } });
    session = editStrengthSession(session, { kind: 'material', id: 'sus304-solution-cold-rolled' });
    expect(session.sources.get('shearModulus')).toBe('');
    expect(evaluateStrengthSession(session, [])).toMatchObject({ ok: false, field: 'shearModulus' });
    session = editStrengthSession(session, { kind: 'source', field: 'shearModulus', source: '70000' });
    expect(evaluateStrengthSession(session, []).ok).toBe(true);
    expect(strengthUsesCustomValues(session)).toBe(true);
    expect(calculateStrengthSession(session, []).result?.materialValuesEdited).toBe(true);
  });
  it('断面の高さを素材の板厚の代わりにせず、板厚条件の変更を検査する', () => {
    let session = editStrengthSession(createStrengthSession('mm'), { kind: 'source', field: 'height', source: '100' });
    expect(evaluateStrengthSession(session, []).ok).toBe(true);
    session = editStrengthSession(session, { kind: 'product-thickness', source: '20mm' });
    expect(evaluateStrengthSession(session, [])).toMatchObject({ ok: false, field: 'productThickness' });
    session = editStrengthSession(session, { kind: 'material', id: 'ss400-plate-16-40' });
    expect(session.sources.get('yieldStress')).toBe('235');
    expect(evaluateStrengthSession(session, []).ok).toBe(true);
  });
  it('未確認のボルト断面積を黙って近似せず、明示指定した近似だけを使用する', () => {
    let session = editStrengthSession(createStrengthSession('mm'), { kind: 'calculation', calculation: { kind: 'bolt' } });
    expect(strengthSessionArea(session)).toMatchObject({ ok: true, area: { value: 58 } });
    session = editStrengthSession(session, { kind: 'thread', designation: 'M52' });
    session = editStrengthSession(session, { kind: 'series', series: 'fine' });
    expect(evaluateStrengthSession(session, [])).toMatchObject({ ok: false, field: 'tensileArea' });
    session = editStrengthSession(session, { kind: 'area-method', method: 'approximation' });
    const outcome = evaluateStrengthSession(session, []);
    expect(outcome.ok && outcome.value.inputs.get('tensileArea')?.canonical.value).toBeCloseTo(Math.PI / 4 * (52 - 0.9382 * 3) ** 2, 10);
  });
  it('入力や計算種類を変えても結果の式・数値・材料条件は計算時点のまま残る', () => {
    const original = calculateStrengthSession(createStrengthSession('mm'), []);
    expect(original.result).not.toBeNull();
    if (original.result === null) throw new Error('missing result');
    let changed = editStrengthSession(original, { kind: 'source', field: 'force', source: '1000N' });
    changed = editStrengthSession(changed, { kind: 'calculation', calculation: { kind: 'shaft' } });
    expect(changed.result).toBe(original.result);
    expect(changed.edited).toBe(true);
    const rows = strengthResultRows(original.result);
    expect(rows.find(row => row.name === 'stress')).toMatchObject({ formula: 'σ = 6*M/(b*h^2)', exact: '6', display: '6' });
    expect(rows.find(row => row.name === 'stress')?.substituted).toBe('6*(1000)/((10)*(10)^2)');
    expect(calculateStrengthSession(changed, []).result?.value.calculation.kind).toBe('shaft');
  });
  it('パラメータの更新は明示的に計算した時点で取り込み、式は数値へ置き換えない', () => {
    const load: Parameter = { name: '荷重', value: { source: '10', value: 10, display: '10' }, unit: 'none', description: '' };
    const session = editStrengthSession(createStrengthSession('mm'), { kind: 'source', field: 'force', source: '荷重' });
    const first = calculateStrengthSession(session, [load]);
    const next = calculateStrengthSession(first, [{ ...load, value: { source: '100', value: 100, display: '100' } }]);
    expect(first.result?.value.results.get('stress')?.value).toBe(6);
    expect(next.result?.value.results.get('stress')?.value).toBe(60);
    expect(next.sources.get('force')).toBe('荷重');
  });
});

describe('ストアの読み取り専用強度計算', () => {
  beforeEach(resetTestStore);
  it('アセンブリでは開いている組立のパラメータを使い、背後の部品や履歴を変えない', () => {
    const load: Parameter = { name: '荷重', value: { source: '30', value: 30, display: '30' }, unit: 'none', description: '' };
    const part = { ...createEmptyPartDocument(), parameters: [{ ...load, value: { source: '100', value: 100, display: '100' } }] };
    useAppStore.getState().applyDocument(part);
    const assembly = { ...createAssemblyDocument('強度確認'), parameters: [load] };
    useAppStore.getState().openAssembly(assembly);
    const before = useAppStore.getState();
    before.toggleStrength();
    useAppStore.getState().editStrength({ kind: 'source', field: 'force', source: '荷重' });
    useAppStore.getState().calculateStrength();
    const after = useAppStore.getState();
    expect(after.strengthSession?.result?.value.results.get('stress')?.value).toBe(18);
    expect(after.assembly).toBe(before.assembly); expect(after.document).toBe(before.document);
    expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack); expect(after.undoStack).toBe(before.undoStack);
  });
  it.each(['new', 'load', 'assembly', 'drawing'])('%sで文書を切り替えると入力と結果を残さない', kind => {
    useAppStore.getState().toggleStrength(); useAppStore.getState().calculateStrength();
    expect(useAppStore.getState().strengthSession?.result).not.toBeNull();
    const store = useAppStore.getState();
    if (kind === 'new') store.resetDocument(createEmptyPartDocument());
    else if (kind === 'load') store.applyDocument(createEmptyPartDocument(), { replacesDocument: true });
    else if (kind === 'assembly') store.openAssembly(createAssemblyDocument('次の組立'));
    else store.openDrawing(createDrawingDocument('次の図面', { sourceRef: 'part1', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-11T00:00:00.000Z' }));
    expect(useAppStore.getState().strengthSession).toBeNull();
  });
  it('開く・式編集・計算では文書とUndoと形状キャッシュを変えない', () => {
    const before = useAppStore.getState();
    before.toggleStrength();
    useAppStore.getState().editStrength({ kind: 'source', field: 'force', source: '20N' });
    useAppStore.getState().calculateStrength();
    const after = useAppStore.getState();
    expect(after.document).toBe(before.document); expect(after.undoStack).toBe(before.undoStack);
    expect(after.bodies).toBe(before.bodies);
    expect(after.strengthSession?.result?.value.results.get('stress')?.value).toBe(12);
    after.closeStrength(); expect(useAppStore.getState().strengthSession).toBeNull();
  });
  it('形の変更とUndoでも計算結果を保ち、閉じる操作で消す', () => {
    useAppStore.getState().toggleStrength(); useAppStore.getState().calculateStrength();
    const result = useAppStore.getState().strengthSession?.result;
    useAppStore.getState().applyDocument(appendSolid(partWithPoint(), extrudeFeature('strength-test')));
    expect(useAppStore.getState().strengthSession?.result).toBe(result);
    useAppStore.getState().undo(); expect(useAppStore.getState().strengthSession?.result).toBe(result);
    useAppStore.getState().toggleStrength(); expect(useAppStore.getState().strengthSession).toBeNull();
  });
});
