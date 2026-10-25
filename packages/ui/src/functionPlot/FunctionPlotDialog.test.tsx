import { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, tick } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { FunctionPlotDialog } from './FunctionPlotDialog.js';
import { FunctionSectionDialog } from './FunctionSectionDialog.js';

// Existing Node SSR/handler convention: real dialog handlers and document ownership,
// controlled asynchronous work. Browser activation itself is covered by the trusted-click E2E.
const harness = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0,
  pending: [] as { signal: AbortSignal; reject: (reason: Error) => void }[],
  dispose: vi.fn(),
}));
vi.mock('react', async importOriginal => {
  const original = await importOriginal<typeof import('react')>();
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
  ...await importOriginal<typeof import('../math/prepareDocumentMathEditor.js')>(),
  waitForMathEditorGeometry: (_document: unknown, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
    harness.pending.push({ signal, reject });
  }),
}));
vi.mock('./functionSectionDraft.js', async importOriginal => ({
  ...await importOriginal<typeof import('./functionSectionDraft.js')>(),
  prepareFunctionSection: (...args: Parameters<typeof import('./functionSectionDraft.js').prepareFunctionSection>) =>
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
});
afterEach(() => { resetTestStore(); });

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
