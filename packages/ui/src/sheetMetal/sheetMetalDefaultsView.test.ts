import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { absoluteCoordinate, createEmptyPartDocument, createSheetBaseFeature, evaluateSheetField, replaceSketch } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { SheetMetalPanel } from './SheetMetalPanel.js';
import { evaluateSheetDraft, sheetSourceLengthUnit } from './sheetDraft.js';
import { sheetDefaultId } from './sheetMetalDefaultSources.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('板金の初期値と欄の単位表示', () => {
  it.each([null, '25.4', '(1)in'])('inch表示でも工場出荷値と保存済みの式%sをmmとして表示し、設定で置き換えない', source => {
    const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
    const part = replaceSketch(empty, { ...sketch, features: [
      { kind: 'rectangle', id: 'rect', name: 'rectangle', planeId: 'xy', construction: false,
        corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
      { kind: 'face', id: 'face', name: 'face', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
    ] });
    const base = createSheetBaseFeature(part, { sketchId: sketch.id, faceFeatureId: 'face' });
    const thicknessValue = evaluateSheetField(source ?? '1', 'length', 'mm');
    if (!thicknessValue.ok) throw new Error(thicknessValue.message);
    const saved = { ...base, rule: { ...base.rule, thickness: thicknessValue.value } };
    const document = source === null ? part : { ...part, solids: [saved] };
    const state = useAppStore.getState(); state.applyDocument(document, { replacesDocument: true });
    state.setDisplaySettings({ ...state.displaySettings, lengthUnit: 'inch',
      numericToolDefaults: source === null ? {} : { [sheetDefaultId('sheetThickness')]: '5' } });
    state.openSheetMetalTool('sheetBase', source === null ? undefined : saved.id);
    const session = useAppStore.getState().sheetMetalTool;
    if (session === null) throw new Error('sheet session is required');
    const before = useAppStore.getState();
    const snapshot = vi.spyOn(React, 'useSyncExternalStore')
      .mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    let markup: string;
    try { markup = renderToStaticMarkup(createElement(SheetMetalPanel, { session })); }
    finally { snapshot.mockRestore(); }
    const labels = markup.match(/<label class="pcad-field">[\s\S]*?<\/label>/gu) ?? [];
    const thickness = labels.find(label => label.includes(t('sheetMetal.thickness')));
    expect(thickness).toContain(`value="${source ?? '1'}"`);
    expect(thickness).toContain('<span>mm</span>');
    expect(thickness).not.toContain('<span>in</span>');
    expect(useAppStore.getState()).toBe(before);
    expect(before.document).toEqual(document);
  });

  it('inch表示中でも設定から渡した25.4mmを25.4inと表示せず、同じ値で確定する', () => {
    const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
    const document = replaceSketch(empty, { ...sketch, features: [
      { kind: 'rectangle', id: 'rect', name: 'rectangle', planeId: 'xy', construction: false,
        corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
      { kind: 'face', id: 'face', name: 'face', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
    ] });
    const state = useAppStore.getState();
    state.applyDocument(document, { replacesDocument: true });
    state.setDisplaySettings({ ...state.displaySettings, lengthUnit: 'inch', numericToolDefaults: {
      [sheetDefaultId('sheetThickness')]: '25.4', [sheetDefaultId('sheetKFactor')]: '0.3',
    } });
    state.openSheetMetalTool('sheetBase');
    const session = useAppStore.getState().sheetMetalTool;
    if (session === null) throw new Error('sheet session is required');
    const before = useAppStore.getState();
    const snapshot = vi.spyOn(React, 'useSyncExternalStore')
      .mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    let markup: string;
    try { markup = renderToStaticMarkup(createElement(SheetMetalPanel, { session })); }
    finally { snapshot.mockRestore(); }
    const labels = markup.match(/<label class="pcad-field">[\s\S]*?<\/label>/gu) ?? [];
    const thickness = labels.find(label => label.includes(t('sheetMetal.thickness')));
    expect(thickness).toContain('value="25.4"');
    expect(thickness).toContain('<span>mm</span>');
    expect(thickness).not.toContain('<span>in</span>');
    expect(useAppStore.getState()).toBe(before);

    const feature = createSheetBaseFeature(document, { sketchId: sketch.id, faceFeatureId: 'face' });
    const value = evaluateSheetDraft(feature, session.defaultSources ?? {}, 'inch', {}, new Set(['sheetThickness']));
    expect(value).toMatchObject({ ok: true, feature: { rule: { thickness: { source: '25.4', value: 25.4 } } } });
    const typed = evaluateSheetDraft(feature, { sheetThickness: '1' }, 'inch', {});
    expect(sheetSourceLengthUnit('sheetThickness', 'inch', new Set())).toBe('inch');
    expect(typed).toMatchObject({ ok: true, feature: { rule: { thickness: { value: 25.4 } } } });
  });
});
