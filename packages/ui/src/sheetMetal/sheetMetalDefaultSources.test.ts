import { evaluateExpression } from '@pointercad/expression';
import {
  appendSolid,
  createEmptyPartDocument,
  createSheetBaseFeature,
  createSheetBendFeature,
  createSheetFlangeFeature,
  defaultSheetMetalRule,
} from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readNumericToolDefaults } from '../settings/numericToolDefaults.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { evaluateSheetDraft } from './sheetDraft.js';
import {
  SHEET_DEFAULT_KEYS,
  sheetDefaultId,
  sheetDefaultSources,
  sheetToolDefaultDefinitions,
  snapshotSheetMetalDefaultSources,
} from './sheetMetalDefaultSources.js';

function expression(source: string) {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

beforeEach(resetTestStore);
afterEach(() => useAppStore.getState().closeSheetMetalTool());

describe('板金10欄の数値初期値', () => {
  it('モデルの作成関数から10欄を漏れなく取り、欄と設定IDを一意にする', () => {
    const defaults = sheetDefaultSources(), entries = sheetToolDefaultDefinitions();
    expect(SHEET_DEFAULT_KEYS).toEqual([
      'sheetThickness', 'sheetRadius', 'sheetKFactor', 'sheetLength', 'sheetAngle',
      'sheetStartOffset', 'sheetEndOffset', 'sheetReliefPosition', 'sheetReliefWidth', 'sheetReliefDepth',
    ]);
    expect(entries).toHaveLength(10);
    expect(new Set(entries.map(entry => entry.id)).size).toBe(10);
    expect(defaults).toEqual({
      sheetThickness: '1', sheetRadius: '1', sheetKFactor: '0.4', sheetLength: '20', sheetAngle: '90',
      sheetStartOffset: '0', sheetEndOffset: '0', sheetReliefPosition: '0', sheetReliefWidth: '1', sheetReliefDepth: '2',
    });
  });

  it('既存の欄定義で範囲・有限値・量の種類を検査する', () => {
    const valid = Object.fromEntries(SHEET_DEFAULT_KEYS.map(key => [sheetDefaultId(key), sheetDefaultSources()[key]]));
    expect(readNumericToolDefaults(valid)).toEqual(valid);
    expect(readNumericToolDefaults({ ...valid, [sheetDefaultId('sheetThickness')]: '0' })).toEqual({});
    expect(readNumericToolDefaults({ ...valid, [sheetDefaultId('sheetKFactor')]: '0.6' })).toEqual({});
    expect(readNumericToolDefaults({ ...valid, [sheetDefaultId('sheetKFactor')]: '0.4mm' })).toEqual({});
    expect(readNumericToolDefaults({ ...valid, [sheetDefaultId('sheetAngle')]: '180' })).toEqual({});
    expect(readNumericToolDefaults({ ...valid, [sheetDefaultId('sheetRadius')]: '1/0' })).toEqual({});
  });

  it('新規開始では設定を不変な写しにし、設定オブジェクトの後続変更を受けない', () => {
    const configured = Object.fromEntries(SHEET_DEFAULT_KEYS.map((key, index) => [sheetDefaultId(key), String(index + 1)]));
    const snapshot = snapshotSheetMetalDefaultSources(configured, undefined);
    configured[sheetDefaultId('sheetThickness')] = '99';
    expect(snapshot.sheetThickness).toBe('1');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.keys(snapshot)).toHaveLength(10);
  });

  it('板金セッションが開始時だけ設定を写し、新しいセッションだけ変更後の値を読む', () => {
    const state = useAppStore.getState();
    state.setDisplaySettings({ ...state.displaySettings, numericToolDefaults: {
      [sheetDefaultId('sheetThickness')]: '3',
    } });
    state.openSheetMetalTool('sheetBase');
    const first = useAppStore.getState().sheetMetalTool;
    if (first === null) throw new Error('sheet tool session was not opened');
    expect(first.defaultSources?.sheetThickness).toBe('3');
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, numericToolDefaults: {
      [sheetDefaultId('sheetThickness')]: '9',
    } });
    expect(first.defaultSources?.sheetThickness).toBe('3');
    useAppStore.getState().openSheetMetalTool('sheetBase');
    expect(useAppStore.getState().sheetMetalTool?.defaultSources?.sheetThickness).toBe('9');

    const document = createEmptyPartDocument();
    const base = createSheetBaseFeature(document, { sketchId: 'sketch', faceFeatureId: 'face' });
    const withBase = appendSolid(document, { ...base, rule: { ...base.rule, thickness: expression('2*2') } });
    useAppStore.getState().applyDocument(withBase, { replacesDocument: true });
    useAppStore.getState().openSheetMetalTool('sheetBase', base.id);
    expect(useAppStore.getState().sheetMetalTool?.editingFeature).toMatchObject({ rule: { thickness: { source: '2*2' } } });
    expect(useAppStore.getState().sheetMetalTool?.defaultSources?.sheetThickness).toBeUndefined();
  });

  it('再編集で既に有効な原式を設定から除外し、継承中の半径・Kだけを新規上書き用に残す', () => {
    const document = createEmptyPartDocument(), settings = {
      [sheetDefaultId('sheetThickness')]: '3', [sheetDefaultId('sheetRadius')]: '7',
      [sheetDefaultId('sheetKFactor')]: '0.2', [sheetDefaultId('sheetLength')]: '40',
      [sheetDefaultId('sheetAngle')]: '45', [sheetDefaultId('sheetStartOffset')]: '2',
      [sheetDefaultId('sheetEndOffset')]: '3',
    };
    const base = createSheetBaseFeature(document, { sketchId: 'sketch', faceFeatureId: 'face' });
    expect(snapshotSheetMetalDefaultSources(settings, base)).toEqual({
      sheetLength: '40', sheetAngle: '45', sheetStartOffset: '2', sheetEndOffset: '3',
    });

    const inherited = createSheetFlangeFeature(document, 'base', []);
    expect(inherited.rule).toEqual({ innerRadius: null, kFactor: null });
    const inheritedSnapshot = snapshotSheetMetalDefaultSources(settings, inherited);
    expect(inheritedSnapshot).toEqual({ sheetThickness: '3', sheetRadius: '7', sheetKFactor: '0.2' });
    const explicit = { ...inherited, rule: { innerRadius: expression('5'), kFactor: expression('0.3') } };
    expect(snapshotSheetMetalDefaultSources(settings, explicit)).toEqual({ sheetThickness: '3' });
  });

  it('継承がnullの間は設定の半径・Kを適用せず、上書き欄を新しく出した時だけ使う', () => {
    const document = createEmptyPartDocument();
    const inherited = createSheetBendFeature(document, 'base', 'panel', {
      sketchId: 'sketch', lineFeatureId: 'line',
    });
    const sources = { sheetRadius: '7', sheetKFactor: '0.2' };
    const unchanged = evaluateSheetDraft(inherited, sources, 'mm', {}, new Set(['sheetRadius', 'sheetKFactor']));
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok || unchanged.feature.kind !== 'sheetBend') throw new Error('bend draft is required');
    expect(unchanged.feature.rule).toEqual({ innerRadius: null, kFactor: null });

    const rule = defaultSheetMetalRule();
    const overridden = { ...inherited, rule: { innerRadius: rule.innerRadius, kFactor: rule.kFactor } };
    const changed = evaluateSheetDraft(overridden, sources, 'mm', {}, new Set(['sheetRadius', 'sheetKFactor']));
    expect(changed.ok).toBe(true);
    if (!changed.ok || changed.feature.kind !== 'sheetBend') throw new Error('overridden bend draft is required');
    expect(changed.feature.rule).toMatchObject({ innerRadius: { source: '7', value: 7 }, kFactor: { source: '0.2', value: 0.2 } });
  });

  it('設定由来の長さだけをmmで評価し、道具で手入力した値は画面のinchとして評価する', () => {
    const document = createEmptyPartDocument();
    const base = createSheetBaseFeature(document, { sketchId: 'sketch', faceFeatureId: 'face' });
    const configured = evaluateSheetDraft(base, { sheetThickness: '25.4' }, 'inch', {}, new Set(['sheetThickness']));
    const typed = evaluateSheetDraft(base, { sheetThickness: '1' }, 'inch', {}, new Set());
    expect(configured.ok).toBe(true); expect(typed.ok).toBe(true);
    if (!configured.ok || configured.feature.kind !== 'sheetBase' || !typed.ok || typed.feature.kind !== 'sheetBase') {
      throw new Error('sheet base drafts are required');
    }
    expect(configured.feature.rule.thickness).toMatchObject({ source: '25.4', value: 25.4 });
    expect(typed.feature.rule.thickness.value).toBeCloseTo(25.4, 12);
    expect(typed.feature.rule.thickness.source).toContain('in');
  });
});
