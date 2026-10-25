import React, { type KeyboardEvent, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { StrengthPanel } from './StrengthPanel.js';

// SSR/real handler tests, not a native Japanese IME or browser default-action test.
type Form = ReactElement<{ onKeyDown: (event: Pick<KeyboardEvent<HTMLFormElement>, 'key' | 'nativeEvent' | 'preventDefault' | 'stopPropagation'>) => void;
  onSubmit: (event: { preventDefault: () => void }) => void }>;
const originalClose = useAppStore.getState().closeStrength;
const originalCalculate = useAppStore.getState().calculateStrength;
const close = vi.fn(originalClose), calculate = vi.fn(originalCalculate);

function form(): Form {
  let element: Form | undefined;
  function Probe(): null {
    const session = useAppStore.getState().strengthSession;
    if (session === null) throw new Error('Missing strength session');
    element = StrengthPanel({ session });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (element === undefined) throw new Error('Missing strength form');
  return element;
}
function keyEvent(key: string, options: KeyboardEventInit = {}) {
  return { key, nativeEvent: new globalThis.KeyboardEvent('keydown', { key, ...options }), preventDefault: vi.fn(), stopPropagation: vi.fn() };
}
beforeEach(() => {
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
  // Node's synthetic native-event shape is sufficient for the actual handler's three-key predicate.
  vi.stubGlobal('KeyboardEvent', class {
    readonly key: string; readonly isComposing: boolean; readonly keyCode: number;
    constructor(_type: string, options: KeyboardEventInit) {
      this.key = options.key ?? ''; this.isComposing = options.isComposing ?? false; this.keyCode = options.keyCode ?? 0;
    }
  });
  close.mockClear(); calculate.mockClear();
  useAppStore.setState({ closeStrength: close, calculateStrength: calculate });
  useAppStore.getState().toggleStrength();
  useAppStore.getState().calculateStrength();
  calculate.mockClear();
  useAppStore.getState().editStrength({ kind: 'source', field: 'force', source: '1k' });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  useAppStore.setState({ closeStrength: originalClose, calculateStrength: originalCalculate });
  resetTestStore();
});

describe('strength form keyboard ownership (Node handlers)', () => {
  it.each([
    ['Escape', { isComposing: true, keyCode: 27 }],
    ['Escape', { isComposing: false, keyCode: 229 }],
    ['Process', { isComposing: false, keyCode: 0 }],
  ] as const)('retains input, session and all results for %s %j', (key, options) => {
    const before = useAppStore.getState().strengthSession, rendered = form(), html = renderToStaticMarkup(rendered);
    expect(before?.sources.get('force')).toBe('1k');
    expect(before?.result?.value.results.get('stress')?.value).toBe(6);
    const event = keyEvent(key, options);
    rendered.props.onKeyDown(event);
    expect(close).not.toHaveBeenCalled(); expect(calculate).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    const after = useAppStore.getState().strengthSession;
    expect(after).toBe(before); expect(after?.sources).toBe(before?.sources); expect(after?.result).toBe(before?.result);
    expect(renderToStaticMarkup(form())).toBe(html);
  });

  it('closes exactly once on ordinary Escape', () => {
    const event = keyEvent('Escape', { isComposing: false, keyCode: 27 });
    form().props.onKeyDown(event);
    expect(close).toHaveBeenCalledOnce(); expect(calculate).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(useAppStore.getState().strengthSession).toBeNull();
  });

  it('leaves ordinary Enter to the form and calculates the completed input on submit', () => {
    useAppStore.getState().editStrength({ kind: 'source', field: 'force', source: '1kN' });
    const rendered = form(), event = keyEvent('Enter', { isComposing: false, keyCode: 13 });
    rendered.props.onKeyDown(event);
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled(); expect(calculate).not.toHaveBeenCalled();
    // Browser implicit submission is covered by strengthFlow, not by this SSR call.
    const submit = { preventDefault: vi.fn() }; rendered.props.onSubmit(submit);
    expect(submit.preventDefault).toHaveBeenCalledOnce(); expect(calculate).toHaveBeenCalledOnce();
    expect(useAppStore.getState().strengthSession?.sources.get('force')).toBe('1kN');
    expect(useAppStore.getState().strengthSession?.result?.value.results.get('stress')?.value).toBe(600);
    expect(close).not.toHaveBeenCalled();
  });
});
