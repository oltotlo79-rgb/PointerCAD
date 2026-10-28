import React, { isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, type SketchConstraint } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { ConstraintList } from './ConstraintList.js';
import { t } from '../i18n/t.js';
import * as fieldUnits from '../shell/propertyFieldUnits.js';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';

// The normal node test environment has no browser DOM. Capture the real React
// host elements while SSR renders the actual memo boundary; invoke their actual
// handlers against the real store. This is behavioral evidence, not paint timing.
const rendered = vi.hoisted(() => { const elements: unknown[] = []; return { elements }; });
vi.mock('react/jsx-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-runtime')>();
  return { ...actual,
    jsx: (...args: Parameters<typeof actual.jsx>) => { const element = actual.jsx(...args); rendered.elements.push(element); return element; },
    jsxs: (...args: Parameters<typeof actual.jsxs>) => { const element = actual.jsxs(...args); rendered.elements.push(element); return element; },
  };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => { const element = actual.jsxDEV(...args); rendered.elements.push(element); return element; },
  };
});
interface Control {
  readonly 'aria-label'?: string;
  readonly 'aria-pressed'?: boolean;
  readonly 'aria-invalid'?: boolean;
  readonly className?: string;
  readonly value?: string;
  readonly onClick?: () => void;
  readonly onChange?: (event: { target: { value: string } }) => void;
  readonly onBlur?: () => void;
}
function view() {
  rendered.elements.length = 0;
  const html = renderToStaticMarkup(<ConstraintList />);
  const controls: Control[] = [];
  for (const value of rendered.elements) {
    if (isValidElement<Control>(value) && typeof value.type === 'string') controls.push(value.props);
  }
  return { html, controls };
}
function field() {
  const found = view().controls.filter(row => row['aria-label'] === `Length ${t('constraintList.valueTooltip')}`);
  expect(found).toHaveLength(1); return found[0];
}
function install(value = 5) {
  const empty = createEmptyPartDocument();
  const constraint: SketchConstraint = { id: 'length', name: 'Length', kind: 'distance',
    a: { kind: 'point', pointId: 'a' }, b: { kind: 'point', pointId: 'b' }, length: expressionValueFromNumber(value) };
  const sketch = { ...empty.sketches[0], features: [
    { id: 'a', name: 'A', kind: 'point' as const, planeId: 'xy', at: absoluteCoordinate(0, 0, 0) },
    { id: 'b', name: 'B', kind: 'point' as const, planeId: 'xy', at: absoluteCoordinate(3, 4, 0) },
  ], constraints: [constraint] };
  const document = replaceSketch(empty, sketch);
  useAppStore.getState().resetDocument(document);
  useAppStore.getState().applyRecompute(document, resultFor(document));
  return document;
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('constraint list memo boundary preserves its own input contracts', () => {
  it('keeps the same full row and value for unrelated selection, and follows selection/clear from its own store', () => {
    install(); const initial = view().html;
    useAppStore.getState().setSelection(['a']);
    expect(view().html).toBe(initial);
    const pick = view().controls.find(row => row.className === 'pcad-constraint-row__pick');
    expect(pick?.['aria-pressed']).toBe(false); pick?.onClick?.();
    expect(useAppStore.getState().selectedConstraintId).toBe('length');
    const chosen = view().controls.find(row => row.className === 'pcad-constraint-row__pick');
    expect(chosen?.['aria-pressed']).toBe(true); chosen?.onClick?.();
    expect(useAppStore.getState().selectedConstraintId).toBeNull();
    expect(field().value).toBe('5');
  });
  it('uses the real dimension edit/delete handlers, rejects unreadable input, and preserves Undo', () => {
    install(); const before = useAppStore.getState();
    field().onChange?.({ target: { value: ')' } });
    expect(useAppStore.getState().document).toBe(before.document);
    field().onChange?.({ target: { value: '6' } });
    const changed = useAppStore.getState();
    expect(changed.sketch.constraints?.[0]).toMatchObject({ id: 'length', length: { value: 6, source: '6' } });
    expect(changed.undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    changed.applyRecompute(changed.document, resultFor(changed.document));
    expect(field().value).toBe('6'); field().onBlur?.();
    const remove = view().controls.find(row => row['aria-label'] === `Length ${t('constraintList.remove')}`);
    expect(remove).toBeDefined(); remove?.onClick?.();
    expect(useAppStore.getState().sketch.constraints).toEqual([]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().sketch.constraints?.[0]).toMatchObject({ id: 'length', length: { value: 6 } });
  });
  it('reads changed units and parameter provenance without reinterpreting the stored numeric source', () => {
    install(); const evaluated = vi.spyOn(fieldUnits, 'evaluateFieldSource');
    expect(field().value).toBe('5');
    useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, lengthUnit: 'inch' });
    expect(field().value).toBe('5');
    expect(evaluated).toHaveBeenLastCalledWith('5', 'ratio', false, expect.objectContaining({ lengthUnit: 'inch' }));
    expect(useAppStore.getState().sketch.constraints?.[0]).toMatchObject({ length: { value: 5, source: '5' } });
  });
  it('replaces summaries with a new document and removes the list for an empty document', () => {
    install(); expect(field().value).toBe('5');
    install(7); expect(field().value).toBe('7');
    const empty = createEmptyPartDocument();
    useAppStore.getState().resetDocument(empty);
    useAppStore.getState().applyRecompute(empty, resultFor(empty));
    expect(view().html).toBe('');
  });
});
