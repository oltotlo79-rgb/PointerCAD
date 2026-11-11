import { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, tick } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FunctionPlotDialog } from './FunctionPlotDialog.js';
import { FunctionSectionDialog } from './FunctionSectionDialog.js';
import type * as ImportedReactTypes from 'react';
import type * as ImportedPrepareDocumentMathEditorTypes from '../math/prepareDocumentMathEditor.js';
import type * as ImportedFunctionSectionDraftTypes from './functionSectionDraft.js';

// Existing Node SSR/handler convention: real dialog handlers and document ownership,
// controlled asynchronous work. Browser activation itself is covered by the trusted-click E2E.
const harness = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0,
  pending: [] as { signal: AbortSignal; reject: (reason: Error) => void }[],
  dispose: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof ImportedReactTypes>();
  return {
    ...original,
    useState: <S,>(initial: S | (() => S)) => {
      const index = harness.state++;
      if (index === harness.values.length) harness.values.push(typeof initial === 'function' ? (initial as () => S)() : initial);
      return [harness.values[index] as S, (next: SetStateAction<S>) => {
        harness.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(harness.values[index] as S) : next;
      }];
    },
    useRef: <T,>(initial: T) => {
      const index = harness.ref++;
      if (index === harness.refs.length) harness.refs.push({ current: initial });
      return harness.refs[index] as { current: T };
    },
  };
});
vi.mock('../math/MathExpressionDialog.js', () => ({ MathExpressionDialog: () => null }));
vi.mock('../math/createBrowserMathClient.js', () => ({ createBrowserMathClient: () => ({ dispose: harness.dispose }) }));
vi.mock('../math/prepareDocumentMathEditor.js', async importOriginal => ({
  ...await importOriginal<typeof ImportedPrepareDocumentMathEditorTypes>(),
  waitForMathEditorGeometry: (_document: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    harness.pending.push({ signal, reject });
  }),
}));
vi.mock('./functionSectionDraft.js', async importOriginal => ({
  ...await importOriginal<typeof ImportedFunctionSectionDraftTypes>(),
  prepareFunctionSection: (...args: Parameters<typeof ImportedFunctionSectionDraftTypes.prepareFunctionSection>) =>
    new Promise<never>((_resolve, reject) => { harness.pending.push({ signal: args[6], reject }); }),
}));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child, ...elements(child.props.children as ReactNode));
  });
  return found;
}
function render(kind: 'plot' | 'section'): Element[] {
  harness.state = 0;
  harness.ref = 0;
  let tree: ReactNode = null;
  function Probe(): null {
    tree = kind === 'plot' ? FunctionPlotDialog({ onClose: () => undefined })
      : FunctionSectionDialog({ parentId: 'controlled-section-parent', onClose: () => undefined });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return elements(tree);
}
function one(nodes: Element[], predicate: (element: Element) => boolean): Element {
  const matches = nodes.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function submit(nodes: Element[]): void {
  const event = { preventDefault: vi.fn() };
  const form = one(nodes, element => element.type === 'form');
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
}
beforeEach(() => {
  harness.values = [];
  harness.refs = [];
  harness.pending = [];
  harness.dispose.mockClear();
  resetTestStore();
  // resetTestStore preserves generation counters; this SSR fixture has no recompute worker.
  useAppStore.setState({ isComputing: false, requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});
afterEach(() => { resetTestStore(); });

describe('plot preview waits for the current document recompute', () => {
  it('starts once the existing recompute succeeds, without losing the submitted intent', async () => {
    useAppStore.setState({ isComputing: true, requestedGeneration: 1, completedGeneration: 0 });
    submit(render('plot'));
    await tick(); expect(harness.pending).toHaveLength(0);
    useAppStore.setState({ isComputing: false, completedGeneration: 1, lastOutcome: 'success' });
    await tick(); expect(harness.pending).toHaveLength(1);
    harness.pending[0].reject(new Error('end test')); await tick();
  });
  it.each(['failed', 'cancelled'] as const)('does not start preview after recompute %s', async outcome => {
    useAppStore.setState({ isComputing: true, requestedGeneration: 1, completedGeneration: 0 });
    submit(render('plot')); await tick();
    useAppStore.setState({ isComputing: false, completedGeneration: 1, lastOutcome: outcome });
    await tick(); expect(harness.pending).toHaveLength(0);
    expect(render('plot').some(element => element.props.role === 'alert')).toBe(true);
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });
  it('stops a waiting preview when the user cancels it', async () => {
    useAppStore.setState({ isComputing: true, requestedGeneration: 1, completedGeneration: 0 });
    submit(render('plot')); await tick();
    const stop = one(render('plot'), element => element.type === 'button' && element.key === 'stop');
    (stop.props.onClick as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    await tick();
    useAppStore.setState({ isComputing: false, completedGeneration: 1, lastOutcome: 'success' });
    await tick(); expect(harness.pending).toHaveLength(0);
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch a waiting preview after an input edit or document generation change', async () => {
    useAppStore.setState({ isComputing: true, requestedGeneration: 1, completedGeneration: 0 });
    let nodes = render('plot'); submit(nodes); await tick();
    nodes = render('plot');
    const field = nodes.find(element => element.type === 'input' && typeof element.props.onChange === 'function');
    if (field === undefined) throw new Error('Missing editable input');
    (field.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '7' } });
    await tick();
    useAppStore.setState({ isComputing: false, completedGeneration: 1, lastOutcome: 'success' });
    await tick(); expect(harness.pending).toHaveLength(0);
    useAppStore.setState({ isComputing: true, requestedGeneration: 2, completedGeneration: 1 });
    nodes = render('plot'); submit(nodes); await tick();
    useAppStore.setState({ documentVersion: useAppStore.getState().documentVersion + 1 });
    await tick(); expect(harness.pending).toHaveLength(0);
  });
});

describe.each(['plot', 'section'] as const)('%s Stop activation and asynchronous ownership', kind => {
  it('cancels the default action before abort and permits only the next explicit submit', async () => {
    const document = useAppStore.getState().document;
    let nodes = render(kind);
    submit(nodes);
    expect(harness.pending).toHaveLength(1);
    nodes = render(kind);
    const stop = one(nodes, element => element.type === 'button' && element.key === 'stop');
    const event = { preventDefault: vi.fn() };
    harness.pending[0].signal.addEventListener('abort', () => expect(event.preventDefault).toHaveBeenCalledOnce(), { once: true });
    (stop.props.onClick as (event: { preventDefault: () => void }) => void)(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(harness.pending[0].signal.aborted).toBe(true);
    nodes = render(kind);
    const next = one(nodes, element => element.type === 'button' && element.props.type === 'submit');
    expect(next.key).toBe('submit');
    expect(next.key).not.toBe(stop.key);
    expect(harness.pending).toHaveLength(1);

    submit(nodes);
    expect(harness.pending).toHaveLength(2);
    expect(harness.pending[1].signal.aborted).toBe(false);
    harness.pending[0].reject(new Error('late cancelled owner'));
    await tick();
    nodes = render(kind);
    expect(nodes.some(element => element.key === 'stop')).toBe(true);
    expect(nodes.some(element => element.props.role === 'alert')).toBe(false);
    expect(harness.dispose).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().document).toBe(document);

    // A document generation change must make even the current pending reply stale.
    useAppStore.setState({ documentVersion: useAppStore.getState().documentVersion + 1 });
    harness.pending[1].reject(new Error('reply for replaced document generation'));
    await tick();
    nodes = render(kind);
    expect(nodes.some(element => element.props.role === 'alert')).toBe(false);
    expect(harness.dispose).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().document).toBe(document);
    expect(harness.pending).toHaveLength(2);
  });
});
