import React from 'react';
import { absoluteCoordinate, appendReference, appendSolid, createEmptyPartDocument } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { pointReferenceCoordinate } from '../sketch/selectedPointEnds.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyFor, extrudeFeature, resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { RadialCommandMenu } from './RadialCommandMenu.js';
import type { RadialMenuAttachmentOptions } from './attachRadialMenuGesture.js';

const effects: Array<() => void | (() => void)> = [];
let onChoose: RadialMenuAttachmentOptions['choose'] | null = null;
let attachment: RadialMenuAttachmentOptions | null = null;
let menuRender: { shown: unknown; states: number; refs: number; cells: Array<{ current: unknown }> } | null = null;

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react,
    useEffect: vi.fn((effect: () => void | (() => void)) => { effects.push(effect); }),
    useState: (initial: unknown) => {
      const actual = react.useState(initial), fixture = menuRender;
      if (fixture === null || fixture.states++ !== 0) return actual;
      return [fixture.shown, (next: unknown) => { fixture.shown = next; }];
    },
    useRef: (initial: unknown) => {
      const actual = react.useRef(initial), fixture = menuRender;
      if (fixture === null) return actual;
      const index = fixture.refs++, saved = fixture.cells[index];
      if (saved !== undefined) return saved;
      fixture.cells.push(actual);
      return actual;
    },
  };
});
vi.mock('./attachRadialMenuGesture.js', () => ({
  attachRadialMenuGesture: vi.fn((_surface: HTMLElement, options: RadialMenuAttachmentOptions) => {
    onChoose = options.choose;
    attachment = options;
    return { choose: vi.fn(), cancel: vi.fn(), detach: vi.fn() };
  }),
}));

afterEach(() => {
  effects.length = 0;
  onChoose = null;
  attachment = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTestStore();
});

describe('Choosing an unavailable radial command', () => {
  it.each([false, true])('vertex-only menu uses the shared execution decision, stale=%s', stale => {
    resetTestStore();
    const state = () => useAppStore.getState();
    const document = appendSolid(createEmptyPartDocument(), extrudeFeature('solid-1'));
    const body = { ...bodyFor('solid-1'),
      mesh: { ...bodyFor('solid-1').mesh, positions: new Float32Array([0, 0, 0, 10, 20, 30]) },
      vertices: [{ index: 0, position: [0, 0, 0] as const }, { index: 1, position: [10, 20, 30] as const }] };
    state().resetDocument(document); state().recordRecomputeRequest(1);
    state().applyRecompute(document, { ...resultFor(document), generation: 1, bodies: [body] });
    state().recordRecomputeCompletion(1, 'success');
    state().setSelection(['solid-1#vertex:0', 'solid-1#vertex:1'], { kind: 'pick' });
    class Surface { matches(selector: string): boolean { return selector === '.pcad-viewport__canvas'; } }
    vi.stubGlobal('HTMLElement', Surface); vi.stubGlobal('SVGElement', class {});
    vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
    vi.stubGlobal('document', { querySelector: () => null });
    const surface = new Surface();
    class Viewport { querySelector(): Surface { return surface; } }
    vi.stubGlobal('HTMLDivElement', Viewport);
    const parent = new Viewport();
    if (!(parent instanceof HTMLDivElement)) throw new Error('viewport element');
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    try { renderToStaticMarkup(<RadialCommandMenu viewport={{ current: parent }} />); }
    finally { snapshot.mockRestore(); }
    const dispose = effects[0]?.();
    try {
      expect(attachment?.allowSelectionModifiers?.()).toBe(true);
      attachment?.show({ pointerId: 1, armed: true, selected: 1,
        geometry: { center: { x: 200, y: 200 }, outerRadius: 152, cancelRadius: 32 } }, true);
      const before = state();
      if (stale) state().recordRecomputeRequest(2);
      onChoose?.(1);
      if (stale) {
        expect(state().document).toBe(before.document);
        expect(state().undoStack).toBe(before.undoStack);
        expect(state().fileMessage?.failed).toBe(true);
      } else {
        expect(state().sketch.features.at(-1)).toMatchObject({ kind: 'line', planeId: 'free',
          from: { base: { kind: 'subShape' } }, to: { base: { kind: 'subShape' } } });
        expect(state().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      }
    } finally { if (typeof dispose === 'function') dispose(); }
  });
  it.each([false, true])('three selected vertices offer the shared face decision in the same slot, stale=%s', stale => {
    resetTestStore();
    const state = () => useAppStore.getState();
    const document = appendSolid(createEmptyPartDocument(), extrudeFeature('solid-1'));
    const body = { ...bodyFor('solid-1'),
      mesh: { ...bodyFor('solid-1').mesh, positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]) },
      vertices: [{ index: 0, position: [0, 0, 0] as const }, { index: 1, position: [10, 0, 0] as const },
        { index: 2, position: [0, 10, 0] as const }] };
    state().resetDocument(document); state().recordRecomputeRequest(1);
    state().applyRecompute(document, { ...resultFor(document), generation: 1, bodies: [body] });
    state().recordRecomputeCompletion(1, 'success');
    state().setSelection(['solid-1#vertex:0', 'solid-1#vertex:1', 'solid-1#vertex:2'], { kind: 'pick' });
    class Surface { matches(selector: string): boolean { return selector === '.pcad-viewport__canvas'; } }
    vi.stubGlobal('HTMLElement', Surface); vi.stubGlobal('SVGElement', class {});
    vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
    vi.stubGlobal('document', { querySelector: () => null });
    const surface = new Surface();
    class Viewport { querySelector(): Surface { return surface; } }
    vi.stubGlobal('HTMLDivElement', Viewport);
    const parent = new Viewport();
    if (!(parent instanceof HTMLDivElement)) throw new Error('viewport element');
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    try { renderToStaticMarkup(<RadialCommandMenu viewport={{ current: parent }} />); }
    finally { snapshot.mockRestore(); }
    const dispose = effects[0]?.();
    try {
      expect(attachment?.allowSelectionModifiers?.()).toBe(true);
      attachment?.show({ pointerId: 1, armed: true, selected: 1,
        geometry: { center: { x: 200, y: 200 }, outerRadius: 152, cancelRadius: 32 } }, true);
      const before = state();
      if (stale) state().recordRecomputeRequest(2);
      onChoose?.(1);
      if (stale) {
        expect(state().document).toBe(before.document);
        expect(state().undoStack).toBe(before.undoStack);
        expect(state().fileMessage).toEqual({ key: 'sketch.facePoints.computing', failed: true });
      } else {
        expect(state().sketch.features.slice(-4).map(feature => feature.kind)).toEqual(['line', 'line', 'line', 'face']);
        expect(state().sketch.features.at(-1)).toMatchObject({ kind: 'face', planeId: 'free' });
        expect(state().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      }
    } finally { if (typeof dispose === 'function') dispose(); }
  });
  it.each([false, true])('renders and executes the reference-point slot with its real shared decision, unsupported=%s', unsupported => {
    resetTestStore();
    const state = () => useAppStore.getState();
    const document = appendReference(createEmptyPartDocument(), { id: 'reference-1', name: 'P', visible: true,
      kind: 'referencePoint', definition: { kind: 'coordinate',
        at: unsupported ? pointReferenceCoordinate('point-1') : absoluteCoordinate(10, 15, 10) } });
    state().resetDocument(document); state().recordRecomputeRequest(1);
    state().applyRecompute(document, { ...resultFor(document), generation: 1 });
    state().recordRecomputeCompletion(1, 'success');
    state().setSelection(['reference-1']);
    class Surface { matches(selector: string): boolean { return selector === '.pcad-viewport__canvas'; } }
    vi.stubGlobal('HTMLElement', Surface); vi.stubGlobal('SVGElement', class {});
    vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
    vi.stubGlobal('document', { querySelector: () => null });
    const surface = new Surface();
    class Viewport { querySelector(): Surface { return surface; } }
    vi.stubGlobal('HTMLDivElement', Viewport);
    const parent = new Viewport();
    if (!(parent instanceof HTMLDivElement)) throw new Error('viewport element');
    const fixture = { shown: null, states: 0, refs: 0, cells: [] };
    menuRender = fixture;
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    let dispose: ReturnType<(typeof effects)[number]> = undefined;
    try {
      renderToStaticMarkup(<RadialCommandMenu viewport={{ current: parent }} />);
      dispose = effects[0]?.();
      expect(attachment).not.toBeNull();
      attachment?.show({ pointerId: 1, armed: true, selected: 1,
        geometry: { center: { x: 200, y: 200 }, outerRadius: 152, cancelRadius: 32 } }, true);
      expect(menuRender.shown).not.toBeNull();
      menuRender.states = 0; menuRender.refs = 0;
      const markup = renderToStaticMarkup(<RadialCommandMenu viewport={{ current: parent }} />);
      const tag = markup.match(/<button\b[^>]*data-command-id="sketch\.pointAtReference"[^>]*>/)?.[0];
      expect(tag).toBeDefined();
      expect(tag).toContain('data-radial-slot="1"');
      const label = renderToStaticMarkup(<>{t('command.sketch.pointAtReference')}</>);
      const description = renderToStaticMarkup(<>{t(unsupported ? 'sketch.referencePoint.unsupported' : 'radial.pointAtReferenceHint')}</>);
      expect(tag).toContain(`title="${label}: ${description}"`);
      expect(markup).toContain(`${label}: ${description}`);
      const before = state();
      if (unsupported) expect(tag).toContain('aria-disabled="true"');
      else expect(tag).not.toContain('aria-disabled');
      onChoose?.(1);
      if (unsupported) {
        expect(state().document).toBe(before.document);
        expect(state().undoStack).toBe(before.undoStack);
        expect(state().fileMessage).toEqual({ key: 'sketch.referencePoint.unsupported', failed: true });
      } else {
        expect(state().sketch.features.at(-1)).toMatchObject({ kind: 'point',
          at: { mode: 'relative', base: { kind: 'point', pointId: 'reference-1' } } });
        expect(state().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
      }
    } finally {
      if (typeof dispose === 'function') dispose();
      snapshot.mockRestore();
      menuRender = null;
    }
  });
  it('shows the shared reason and preserves ongoing computation and progress', () => {
    resetTestStore();
    const progress = { featureId: 'feature-1', index: 0, total: 2, label: 'Calculating' };
    useAppStore.setState({ isComputing: true, recomputeProgress: progress });
    class Surface { matches(): boolean { return true; } }
    vi.stubGlobal('HTMLElement', Surface);
    vi.stubGlobal('SVGElement', class {});
    vi.stubGlobal('MutationObserver', class { observe(): void {} disconnect(): void {} });
    const surface = new Surface();
    const parent = { querySelector: () => surface } as unknown as HTMLDivElement;
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    try { renderToStaticMarkup(<RadialCommandMenu viewport={{ current: parent }} />); }
    finally { snapshot.mockRestore(); }
    const dispose = effects[0]?.();
    expect(onChoose).not.toBeNull();
    // Slot 7 is Undo; a fresh document has no action to undo.
    onChoose?.(7);
    expect(useAppStore.getState().fileMessage).toEqual({ key: 'command.unavailable.undo', failed: true });
    expect(useAppStore.getState().isComputing).toBe(true);
    expect(useAppStore.getState().recomputeProgress).toBe(progress);
    expect(useAppStore.getState().errorMessage).toBeNull();
    if (typeof dispose === 'function') dispose();
  });
});
