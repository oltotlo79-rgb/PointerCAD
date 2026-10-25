import { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMathBackend, createFunctionMathSource } from '@pointercad/expression/math/worker';
import { readFunctionPointChoice, type FunctionPointReference } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore, tick } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { FunctionDirectionDialog } from './FunctionDirectionDialog.js';
import type { FunctionDirectionPreview } from './functionDirectionDraft.js';

// Node SSR/handler convention from FunctionPlotDialog.test.tsx. Reconciliation slots,
// cancellation and ownership are checked here; actual focus/F1 needs the browser flow.
const harness = vi.hoisted(() => ({
  values: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0,
  effects: [] as (() => void | (() => void))[],
  pending: [] as { signal: AbortSignal; isCurrent: () => boolean; resolve: (value: FunctionDirectionPreview | null) => void }[],
  dispose: vi.fn(), close: vi.fn(), apply: vi.fn(),
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
    useEffect: (effect: () => void | (() => void)) => {
      if (harness.effects.length === 0) harness.effects.push(effect);
    },
  };
});
vi.mock('../math/MathExpressionDialog.js', () => ({ MathExpressionDialog: () => null }));
vi.mock('../math/createBrowserMathClient.js', () => ({ createBrowserMathClient: () => ({ dispose: harness.dispose }) }));
vi.mock('./functionDirectionDraft.js', async importOriginal => ({
  ...await importOriginal<typeof import('./functionDirectionDraft.js')>(),
  evaluateFunctionDirection: (...args: Parameters<typeof import('./functionDirectionDraft.js').evaluateFunctionDirection>) =>
    new Promise<FunctionDirectionPreview | null>(resolve => {
      harness.pending.push({ signal: args[9], isCurrent: args[10], resolve });
    }),
}));

type Element = ReactElement<Record<string, unknown>>;
type Preventable = { preventDefault: () => void };
const applyDocument = useAppStore.getState().applyDocument;
let reference: FunctionPointReference;
let cleanup: (() => void) | undefined;

function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child, ...elements(child.props.children as ReactNode));
  });
  return found;
}
function render(): Element[] {
  harness.state = 0; harness.ref = 0;
  let tree: ReactNode = null;
  function Probe(): null {
    tree = FunctionDirectionDialog({ pointId: 'chosen', reference, onClose: harness.close });
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
function action(nodes: Element[], title: string): Element {
  return one(nodes, element => element.type === 'button' && element.props.title === title);
}
function calculation(nodes: Element[], busy = false): Element {
  return action(nodes, t(busy ? 'functionPlot.control.stopDirection' : 'functionPlot.control.previewDirection'));
}
function submit(nodes: Element[]): void {
  const event = { preventDefault: vi.fn() };
  (one(nodes, element => element.type === 'form').props.onSubmit as (event: Preventable) => void)(event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
}
function click(element: Element, event = { preventDefault: vi.fn() }): typeof event {
  (element.props.onClick as (event: Preventable) => void)(event);
  return event;
}
function expectSameSlot(before: Element[], after: Element[], busy: boolean): void {
  const previous = calculation(before), next = calculation(after, busy);
  const actions = (nodes: Element[]) => one(nodes, element => element.props.className === 'pcad-function-actions');
  const previousChildren = elements(actions(before).props.children as ReactNode);
  const nextChildren = elements(actions(after).props.children as ReactNode);
  expect(next.type).toBe(previous.type);
  expect(next.key).toBe(previous.key);
  expect(nextChildren.indexOf(next)).toBe(previousChildren.indexOf(previous));
  expect(one(after, element => element.type === 'dialog').props['data-help-topic']).toBe('function-point');
}
function preview(): FunctionDirectionPreview {
  return { document: useAppStore.getState().document, from: [0, 0, 0], to: [0, 10, 0], minimum: [-1, -1, -1], maximum: [1, 10, 1] };
}
beforeEach(() => {
  resetTestStore();
  harness.values = []; harness.refs = []; harness.effects = []; harness.pending = [];
  harness.dispose.mockClear(); harness.close.mockClear(); harness.apply.mockClear(); cleanup = undefined;
  useAppStore.setState({ applyDocument: harness.apply });
  const expression = createFunctionMathSource('X^2+Y^2-1', 'text', 'degree', { axes: ['X', 'Y'], parameters: [], coefficients: [] }, createMathBackend());
  reference = { kind: 'functionPoint', parent: { kind: 'curve', sketchId: useAppStore.getState().sketch.id, featureId: 'curve' },
    known: [], choice: readFunctionPointChoice({ input: { expression, minimum: [-2, -2, -2], maximum: [2, 2, 2], tolerance: 1e-6,
      coefficients: [], known: [{ axis: 'X', value: 0 }], fixed: { axis: 'Z', value: 0 } },
    location: { kind: 'implicit', axis: 'Y', interval: { lower: 1, upper: 1 } } }) };
  render();
  // Minimal effect environment only. No DOM or focus is simulated by these globals.
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  cleanup = harness.effects[0]() ?? undefined;
});
afterEach(async () => {
  cleanup?.();
  for (const pending of harness.pending) pending.resolve(null);
  await tick();
  vi.unstubAllGlobals();
  useAppStore.setState({ applyDocument });
  resetTestStore();
});

describe('direction calculation activation and ownership (Node handlers)', () => {
  it('keeps the calculation button in the same reconciliation slot until completion and applies once', async () => {
    const idle = render();
    expect(calculation(idle).props.type).toBe('submit');
    submit(idle);
    const busy = render();
    expectSameSlot(idle, busy, true);
    expect(calculation(busy, true).props.type).toBe('button');
    expect(action(busy, t('functionPlot.control.applyDirection')).props.disabled).toBe(true);
    const ready = preview();
    harness.pending[0].resolve(ready);
    await tick();
    const completed = render();
    expectSameSlot(idle, completed, false);
    expect(harness.pending).toHaveLength(1);
    expect(harness.pending[0].signal.aborted).toBe(false);
    expect(calculation(completed).props.type).toBe('submit');
    expect(action(completed, t('functionPlot.control.applyDirection')).props.disabled).toBe(false);
    expect(harness.apply).not.toHaveBeenCalled();
    click(action(completed, t('functionPlot.control.applyDirection')));
    expect(harness.apply).toHaveBeenCalledExactlyOnceWith(ready.document);
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('prevents Stop default before one abort, submits zero times on Stop and rejects the late result', async () => {
    const idle = render(); submit(idle);
    const busy = render(), event = { preventDefault: vi.fn() }, aborted = vi.fn(() => {
      expect(event.preventDefault).toHaveBeenCalledOnce();
    });
    harness.pending[0].signal.addEventListener('abort', aborted);
    click(calculation(busy, true), event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(aborted).toHaveBeenCalledOnce();
    expect(harness.pending[0].isCurrent()).toBe(false);
    const stopped = render(); expectSameSlot(idle, stopped, false);
    // Model the default-action boundary: the same node is now submit, but Stop cancelled its click.
    if (event.preventDefault.mock.calls.length === 0 && calculation(stopped).props.type === 'submit') submit(stopped);
    expect(harness.pending).toHaveLength(1);
    expect(action(stopped, t('functionPlot.control.applyDirection')).props.disabled).toBe(true);
    submit(stopped);
    expect(harness.pending).toHaveLength(2);
    harness.pending[0].resolve(preview()); await tick();
    const waiting = render(); expectSameSlot(idle, waiting, true);
    expect(action(waiting, t('functionPlot.control.applyDirection')).props.disabled).toBe(true);
    expect(harness.apply).not.toHaveBeenCalled();
    expect(aborted).toHaveBeenCalledOnce();
    harness.pending[1].resolve(preview()); await tick();
    expect(action(render(), t('functionPlot.control.applyDirection')).props.disabled).toBe(false);
    expect(harness.dispose).toHaveBeenCalledTimes(2);
  });

  it.each(['button', 'dialog'] as const)('cancels through %s then unmounts without adopting a late result', async entrance => {
    submit(render()); const busy = render(), aborted = vi.fn();
    harness.pending[0].signal.addEventListener('abort', aborted);
    if (entrance === 'button') click(action(busy, t('functionPlot.control.cancelDirection')));
    else {
      const event = { preventDefault: vi.fn() };
      (one(busy, element => element.type === 'dialog').props.onCancel as (event: Preventable) => void)(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(harness.close).toHaveBeenCalledOnce();
    cleanup?.(); cleanup = undefined;
    expect(aborted).toHaveBeenCalledOnce();
    expect(harness.pending[0].isCurrent()).toBe(false);
    harness.pending[0].resolve(preview()); await tick();
    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.dispose).toHaveBeenCalledOnce();
    expect(harness.pending).toHaveLength(1);
  });

  it('aborts and closes on a document generation change and ignores its reply', async () => {
    submit(render()); const aborted = vi.fn();
    harness.pending[0].signal.addEventListener('abort', aborted);
    useAppStore.setState({ documentVersion: useAppStore.getState().documentVersion + 1 });
    expect(aborted).toHaveBeenCalledOnce(); expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.pending[0].isCurrent()).toBe(false);
    harness.pending[0].resolve(preview()); await tick();
    expect(action(render(), t('functionPlot.control.applyDirection')).props.disabled).toBe(true);
    expect(harness.apply).not.toHaveBeenCalled();
  });
});
