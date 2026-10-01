import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { appendSolid, createEmptyPartDocument, type MeasureOutcome } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { PropertyPanel } from '../shell/PropertyPanel.js';
import { bodyFor, extrudeFeature, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { dispatchCommandKey } from './commandRegistry.js';

class EscapeEvent extends Event implements KeyboardEvent {
  readonly key = 'Escape';
  readonly code = 'Escape';
  readonly keyCode = 27;
  readonly which = 27;
  readonly charCode = 0;
  readonly location = 0;
  readonly detail = 0;
  readonly view = null;
  readonly ctrlKey = false;
  readonly metaKey = false;
  readonly altKey = false;
  readonly shiftKey = false;
  readonly repeat = false;
  readonly isComposing = false;
  readonly DOM_KEY_LOCATION_STANDARD = 0;
  readonly DOM_KEY_LOCATION_LEFT = 1;
  readonly DOM_KEY_LOCATION_RIGHT = 2;
  readonly DOM_KEY_LOCATION_NUMPAD = 3;
  getModifierState(): boolean { return false; }
  initKeyboardEvent(): never { throw new Error('Use the event constructor'); }
  initUIEvent(): never { throw new Error('Use the event constructor'); }
}

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ measurementRequest: null, massDensityDraft: null });
  vi.stubGlobal('Element', class {});
  vi.stubGlobal('HTMLElement', class {});
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTestStore();
  useAppStore.setState({ measurementRequest: null, massDensityDraft: null });
});

function panel(): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore')
    .mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(PropertyPanel)); }
  finally { snapshot.mockRestore(); }
}

function pending(selection: readonly string[]): (outcome: MeasureOutcome) => void {
  const document = ['a', 'b'].reduce((part, id) => appendSolid(part, extrudeFeature(id)), createEmptyPartDocument());
  const calls: ((outcome: MeasureOutcome) => void)[] = [];
  useAppStore.getState().resetDocument(document);
  useAppStore.setState({ bodies: ['a', 'b'].map(bodyFor), selection, isComputing: false,
    partMeasurer: () => new Promise(resolve => { calls.push(resolve); }) });
  useAppStore.getState().measureSelection();
  expect(calls).toHaveLength(1);
  expect(useAppStore.getState().measurementRequest).not.toBeNull();
  expect(useAppStore.getState().measurement).toBeNull();
  expect(useAppStore.getState().massProperties).toBeNull();
  return calls[0];
}

describe('FIX-02 first measurement cancellation through the real Escape command', () => {
  const cases: readonly { name: string; selection: readonly string[]; outcome: MeasureOutcome }[] = [
    { name: 'distance', selection: ['a', 'b'], outcome: {
      kind: 'distance', distance: 25.4, pointA: [0, 0, 0], pointB: [25.4, 0, 0], inner: false,
    } },
    { name: 'mass', selection: ['a'], outcome: {
      kind: 'massProperties', volume: 1000, area: 600, centreOfMass: [0, 0, 0], principalMoments: [1, 2, 3],
      principalAxes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    } },
    { name: 'failure', selection: ['a', 'b'], outcome: { kind: 'failed', message: 'Late failure' } },
  ];
  it.each(cases)('cancels pending $name and ignores its delayed completion', async ({ selection, outcome }) => {
    const complete = pending(selection);
    useAppStore.getState().setSelection([]);
    const before = useAppStore.getState();
    const markup = panel();
    expect(markup).toContain(t('propertyPanel.sectionMeasure'));
    expect(markup).toContain(t('propertyPanel.measurePending'));
    expect(markup).toContain(t('propertyPanel.measureCancelTooltip'));

    const event = new EscapeEvent('keydown', { cancelable: true });
    expect(dispatchCommandKey(event, 'capture')).toEqual({ status: 'executed',
      commandId: 'workspace.clearMeasurement', ready: true, reasonKey: null });
    expect(event.defaultPrevented).toBe(true);
    const cancelled = useAppStore.getState();
    expect(cancelled).toEqual({ ...before, measurementRequest: null });
    expect(panel()).not.toContain(t('propertyPanel.measurePending'));
    expect(panel()).not.toContain(t('propertyPanel.measureCancelTooltip'));

    complete(outcome);
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(useAppStore.getState()).toBe(cancelled);
    expect(dispatchCommandKey(new EscapeEvent('keydown', { cancelable: true }), 'capture')).toEqual({ status: 'unmatched' });
  });
});
