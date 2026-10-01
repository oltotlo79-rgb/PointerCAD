import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { RadialCommandMenu } from './RadialCommandMenu.js';
import type { RadialMenuAttachmentOptions } from './attachRadialMenuGesture.js';

const effects: Array<() => void | (() => void)> = [];
let onChoose: RadialMenuAttachmentOptions['choose'] | null = null;

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>();
  return { ...react, useEffect: vi.fn((effect: () => void | (() => void)) => { effects.push(effect); }) };
});
vi.mock('./attachRadialMenuGesture.js', () => ({
  attachRadialMenuGesture: vi.fn((_surface: HTMLElement, options: RadialMenuAttachmentOptions) => {
    onChoose = options.choose;
    return { choose: vi.fn(), cancel: vi.fn(), detach: vi.fn() };
  }),
}));

afterEach(() => {
  effects.length = 0;
  onChoose = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTestStore();
});

describe('Choosing an unavailable radial command', () => {
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
