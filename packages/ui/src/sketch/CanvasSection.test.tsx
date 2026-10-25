import React, { type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newSketchCanvas } from '../file/canvasFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { CanvasImageLoad } from './canvasActionState.js';
import { CanvasSection } from './CanvasSection.js';

// Keep the real component, store, JSX and event handlers; Node supplies no DOM.
// Native focus/caret and keyboard dispatch are covered by canvasStateFlow.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0 }));
const rendered = vi.hoisted(() => ({ tags: [] as { tag: string; props: Record<string, unknown> }[] }));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
  return { ...original,
    useState: <S,>(initial: S | (() => S)) => {
      const index = hooks.state++;
      if (index === hooks.values.length) hooks.values.push(typeof initial === 'function' ? (initial as () => S)() : initial);
      return [hooks.values[index] as S, (next: SetStateAction<S>) => {
        hooks.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(hooks.values[index] as S) : next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = hooks.ref++;
      if (index === hooks.refs.length) hooks.refs.push({ current: initial });
      return hooks.refs[index] as { current: T };
    },
  };
});
vi.mock('react/jsx-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-runtime')>();
  const capture = (factory: typeof runtime.jsx): typeof runtime.jsx => (type, props, key) => {
    if (typeof type === 'string' && props !== null && typeof props === 'object') rendered.tags.push({ tag: type, props: props as Record<string, unknown> });
    return factory(type, props, key);
  };
  return { ...runtime, jsx: capture(runtime.jsx), jsxs: capture(runtime.jsxs) };
});
vi.mock('react/jsx-dev-runtime', async importOriginal => {
  const runtime = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  const jsxDEV: typeof runtime.jsxDEV = (type, props, key, isStatic, source, self) => {
    if (typeof type === 'string' && props !== null && typeof props === 'object') rendered.tags.push({ tag: type, props: props as Record<string, unknown> });
    return runtime.jsxDEV(type, props, key, isStatic, source, self);
  };
  return { ...runtime, jsxDEV };
});

const canvas = newSketchCanvas([], 'xy', 'A.png', { width: 800, height: 400 }, 'canvas-1');
const bytes = Uint8Array.of(1, 2, 3);
const state = () => useAppStore.getState();
const label = (key: MessageKey) => t(key).replace('{name}', canvas.name);
function render(): string {
  hooks.state = 0; hooks.ref = 0; rendered.tags = [];
  return renderToStaticMarkup(<CanvasSection />);
}
function control(tag: string, name?: string): Record<string, unknown> {
  const matches = rendered.tags.filter(item => item.tag === tag && (name === undefined || item.props['aria-label'] === name));
  expect(matches).toHaveLength(1); return matches[0].props;
}
function handler<T>(props: Record<string, unknown>, event: string): (value: T) => void {
  expect(typeof props[event]).toBe('function'); return props[event] as (value: T) => void;
}
function change(value: string): void {
  handler<{ target: { value: string } }>(control('input'), 'onChange')({ target: { value } }); render();
}
function key(name: string, value: string, composing = false) {
  const event = { key: name, keyCode: 0, nativeEvent: { isComposing: composing }, currentTarget: { value },
    preventDefault: vi.fn(), stopPropagation: vi.fn() };
  handler<typeof event>(control('input'), 'onKeyDown')(event); return event;
}
function blur(value: string): void { handler<{ currentTarget: { value: string } }>(control('input'), 'onBlur')({ currentTarget: { value } }); }
function ready(): void { state().setCanvasPixelSize(canvas.imageId, { width: 800, height: 400 }); }
beforeEach(() => {
  hooks.values = []; hooks.refs = []; resetTestStore(); state().addCanvas(canvas, bytes);
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('CanvasSection status and action reasons', () => {
  it('shows pixels only after decoding and distinguishes physical dimensions', () => {
    const loading = render();
    expect(loading).toContain(t('propertyPanel.canvasStatusLoading'));
    expect(loading).toContain(t('propertyPanel.canvasPixelsUnknown'));
    expect(loading).not.toContain('800 × 400 px');
    expect(control('button', label('propertyPanel.canvasScaleLabel')).disabled).toBe(true);
    expect(control('button', label('propertyPanel.canvasRectifyLabel')).disabled).toBe(true);
    expect(loading).toContain(t('propertyPanel.canvasReasonLoading'));
    ready(); const loaded = render();
    expect(loaded).toContain('800 × 400 px'); expect(loaded).toContain('100 × 50 mm');
    expect(control('button', label('propertyPanel.canvasScaleLabel')).disabled).toBe(false);
    expect(control('button', label('propertyPanel.canvasRectifyLabel')).disabled).toBe(false);
    expect(control('button', label('propertyPanel.canvasRemoveLabel'))).toBeDefined();
    expect(control('button', label('propertyPanel.canvasVisibleLabel'))).toBeDefined();
    useAppStore.setState({ displaySettings: { ...state().displaySettings, lengthUnit: 'inch' } });
    expect(render()).toContain('3.93700787402 × 1.96850393701 in');
  });

  it('shows failure and missing-asset reasons and retries without document changes', () => {
    const failed: CanvasImageLoad = { documentId: state().activeDocumentId, bytes, request: {}, status: 'failed' };
    state().setCanvasImageLoad(canvas.imageId, failed, failed);
    const markup = render();
    expect(markup).toContain(t('propertyPanel.canvasStatusFailed'));
    expect(markup).toContain(t('propertyPanel.canvasReasonFailed'));
    const before = state();
    handler<undefined>(control('button', label('propertyPanel.canvasRetryLabel')), 'onClick')(undefined);
    expect(state().canvasImageRetries.get(canvas.imageId)).toBe(1);
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
    state().setCanvasImages(new Map());
    const missing = render(); expect(missing).toContain(t('propertyPanel.canvasStatusMissing'));
    expect(missing).toContain(t('propertyPanel.canvasReasonMissing'));
    expect(control('button', label('propertyPanel.canvasScaleLabel')).disabled).toBe(true);
    expect(control('button', label('propertyPanel.canvasRectifyLabel')).disabled).toBe(true);
  });

  it('rejects a scale button rendered for a previous document', () => {
    ready(); render(); const scale = control('button', label('propertyPanel.canvasScaleLabel'));
    state().resetDocument(state().document); const before = state();
    handler<undefined>(scale, 'onClick')(undefined);
    expect(state().canvasScale).toBeNull(); expect(state().document).toBe(before.document);
    expect(state().undoStack).toBe(before.undoStack);
  });

  it('rejects stale rectification controls and shows clear only after apply', () => {
    ready(); render();
    const oldRectify = control('button', label('propertyPanel.canvasRectifyLabel'));
    expect(render()).not.toContain(t('propertyPanel.canvasClearRectification'));
    state().resetDocument(state().document);
    const before = state();
    handler<undefined>(oldRectify, 'onClick')(undefined);
    expect(state().canvasRectification).toBeNull();
    expect(state().document).toBe(before.document);
    expect(state().undoStack).toBe(before.undoStack);
    state().setCanvasImages(new Map([[canvas.imageId, bytes]]));
    ready(); render();
    handler<undefined>(control('button', label('propertyPanel.canvasRectifyLabel')), 'onClick')(undefined);
    expect(state().canvasRectification?.canvasId).toBe(canvas.id);
    state().cancelCanvasRectification();
    state().startCanvasRectification(canvas.id);
    for (const point of [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] as const) {
      state().addCanvasRectificationPoint(point);
    }
    expect(state().applyCanvasRectification()).toBe(true);
    expect(render()).toContain(t('propertyPanel.canvasClearRectification'));
    const beforeClear = state();
    handler<undefined>(control('button', label('propertyPanel.canvasClearRectificationLabel')), 'onClick')(undefined);
    expect(state().document.canvases[0].rectification).toBeUndefined();
    expect(state().undoStack.past).toHaveLength(beforeClear.undoStack.past.length + 1);
  });

  it('does not apply old visibility, removal, or scaling controls to a reused canvas ID', () => {
    ready(); render();
    const controls = ['propertyPanel.canvasVisibleLabel', 'propertyPanel.canvasRemoveLabel',
      'propertyPanel.canvasScaleLabel', 'propertyPanel.canvasRectifyLabel'] as const;
    const buttons = controls.map(key => control('button', label(key)));
    state().removeCanvas(canvas.id);
    state().addCanvas(newSketchCanvas([], 'xy', 'B.png', { width: 50, height: 50 }, 'replacement'), bytes);
    state().setCanvasPixelSize('replacement', { width: 50, height: 50 });
    const before = state();
    for (const button of buttons) handler<undefined>(button, 'onClick')(undefined);
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
    expect(state().canvasScale).toBeNull();
    expect(state().canvasRectification).toBeNull();
  });
});

describe('CanvasSection opacity commit', () => {
  it.each(['', '0.', String.fromCodePoint(0x3042), '-0.1', '1.1'])('preserves %j without changing document or history on Enter/blur', value => {
    render(); const before = state(); change(value);
    expect(control('input').value).toBe(value); expect(control('input')['aria-invalid']).toBe(true);
    key('Enter', value); blur(value); render();
    expect(control('input').value).toBe(value);
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
    key('Escape', value); render(); expect(control('input').value).toBe(canvas.opacity.source);
  });

  it('preserves IME drafts and commits Enter plus blur as one undo step', () => {
    render(); const before = state();
    handler<undefined>(control('input'), 'onCompositionStart')(undefined); change('0.25');
    expect(key('Enter', '0.25', true).preventDefault).not.toHaveBeenCalled(); blur('0.25');
    expect(state().document).toBe(before.document); expect(state().undoStack).toBe(before.undoStack);
    handler<undefined>(control('input'), 'onCompositionEnd')(undefined);
    key('Enter', '0.25'); render(); blur('0.25');
    expect(state().document.canvases[0].opacity.value).toBe(0.25);
    expect(state().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    state().undo(); render(); expect(control('input').value).toBe(canvas.opacity.source);
    state().redo(); render(); expect(control('input').value).toBe('0.25');
  });

  it('commits valid blur once and rejects an old input for a reused canvas ID', () => {
    render(); const before = state(); change('0.75'); blur('0.75');
    expect(state().document.canvases[0].opacity.value).toBe(0.75);
    expect(state().undoStack.past).toHaveLength(before.undoStack.past.length + 1);
    render(); const oldInput = control('input');
    state().removeCanvas(canvas.id);
    state().addCanvas(newSketchCanvas([], 'xy', 'B.png', { width: 50, height: 50 }, 'replacement'), bytes);
    const replacement = state();
    handler<{ currentTarget: { value: string } }>(oldInput, 'onBlur')({ currentTarget: { value: '0.1' } });
    expect(state().document).toBe(replacement.document); expect(state().undoStack).toBe(replacement.undoStack);
  });
});
