/**
 * 書き出しのパネルの判断(P6 §0.a-0.20、タスク32)。
 *
 * 画面そのものは描かず、**押す前に決まること**だけを固定する。パネルの見せ方
 * (どの欄が出るか)は `exchangeFile.ts` の `exportPanelShape` の検査が持っているので、
 * ここは「選んでいる立体をどう数えるか」だけを見る。
 */

import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrintabilityReport } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { rememberPrintabilityDisplayMeshes } from '../solid/printabilityColors.js';
import { bodyFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppState } from '../store/appState.js';
import { ExchangePanel, ExportPrintPreflight, selectedBodyFeatureIds } from './ExchangePanel.js';
import type { ExchangeDeps, ExchangeExportOutcome, ExchangeExportRequest } from './exchangeFile.js';
import type { FileGateway, SaveFileKind } from './fileGateway.js';

interface PanelHookRuntime {
  slots: unknown[];
  cursor: number;
  pending: Array<() => void | (() => void)>;
  effects: Array<(() => void | (() => void)) | undefined>;
  cleanups: Array<() => void>;
}
const panelHooks = vi.hoisted(() => ({ active: null as PanelHookRuntime | null }));

// Node の単体検査にDOMは無い。Reactのhookを実行し、effectとcleanupを順に発火させる。
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T, deps: readonly unknown[]): T => {
      const runtime = panelHooks.active;
      if (runtime === null) return actual.useCallback(callback, deps);
      const slot = runtime.cursor++;
      const prior = runtime.slots[slot] as { callback: T; deps: readonly unknown[] } | undefined;
      if (prior === undefined || prior.deps.length !== deps.length
          || prior.deps.some((value, index) => !Object.is(value, deps[index]))) {
        runtime.slots[slot] = { callback, deps: [...deps] };
      }
      return (runtime.slots[slot] as { callback: T }).callback;
    },
    useState: <T,>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] => {
      const runtime = panelHooks.active;
      if (runtime === null) return actual.useState(initial);
      const slot = runtime.cursor++;
      if (!(slot in runtime.slots)) runtime.slots[slot] = typeof initial === 'function' ? (initial as () => T)() : initial;
      return [runtime.slots[slot] as T, (next) => {
        const previous = runtime.slots[slot] as T;
        runtime.slots[slot] = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
      }];
    },
    useRef: <T,>(initial: T): { current: T } => {
      const runtime = panelHooks.active;
      if (runtime === null) return actual.useRef(initial);
      const slot = runtime.cursor++;
      if (!(slot in runtime.slots)) runtime.slots[slot] = { current: initial };
      return runtime.slots[slot] as { current: T };
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]): void => {
      const runtime = panelHooks.active;
      if (runtime === null) return actual.useEffect(effect, deps);
      const slot = runtime.cursor++;
      const before = runtime.slots[slot] as readonly unknown[] | undefined;
      if (!(slot in runtime.slots) || deps === undefined
          || before === undefined || before.length !== deps.length
          || before.some((value, index) => !Object.is(value, deps[index]))) {
        runtime.slots[slot] = deps;
        runtime.effects[slot] = effect;
        runtime.pending.push(effect);
      }
    },
  };
});

vi.mock('../store/useAppStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/useAppStore.js')>();
  const original = actual.useAppStore;
  const hook = Object.assign(
    <T,>(selector: (state: AppState) => T): T => panelHooks.active === null
      ? original(selector) : selector(original.getState()),
    { getState: original.getState, getInitialState: original.getInitialState,
      setState: original.setState, subscribe: original.subscribe },
  );
  return { ...actual, useAppStore: hook };
});

function panelHarness() {
  const runtime: PanelHookRuntime = { slots: [], cursor: 0, pending: [], effects: [], cleanups: [] };
  return {
    render(props: Parameters<typeof ExchangePanel>[0]): ReactElement {
      runtime.cursor = 0;
      panelHooks.active = runtime;
      try {
        const root = ExchangePanel(props);
        for (const effect of runtime.pending.splice(0)) {
          const cleanup = effect();
          if (cleanup !== undefined) runtime.cleanups.push(cleanup);
        }
        return root;
      } finally { panelHooks.active = null; }
    },
    strictReplay(): void {
      for (const cleanup of runtime.cleanups.splice(0).reverse()) cleanup();
      for (const effect of runtime.effects) {
        if (effect === undefined) continue;
        const cleanup = effect();
        if (cleanup !== undefined) runtime.cleanups.push(cleanup);
      }
    },
    unmount(): void { for (const cleanup of runtime.cleanups.splice(0).reverse()) cleanup(); },
  };
}

function elementWith(root: unknown, match: (element: ReactElement) => boolean): ReactElement {
  if (Array.isArray(root)) {
    for (const child of root) {
      try { return elementWith(child, match); } catch { /* continue */ }
    }
  }
  if (isValidElement(root)) {
    if (match(root)) return root;
    return elementWith((root.props as { children?: unknown }).children, match);
  }
  throw new Error('Panel element missing');
}

function observedSave() {
  const calls: Array<{ fileName: string; kind: SaveFileKind; bytes: Uint8Array;
    hasControl: boolean; signalAborted: boolean | undefined; isCurrent: boolean | undefined }> = [];
  const save = vi.fn<NonNullable<FileGateway['saveFileAs']>>((fileName, kind, bytes, control) => {
    calls.push({ fileName, kind, bytes, hasControl: control !== undefined,
      signalAborted: control?.signal.aborted, isCurrent: control?.isCurrent() });
    return Promise.resolve(true);
  });
  return { save, calls };
}

function expectCurrentSave(
  calls: ReturnType<typeof observedSave>['calls'], fileName: string, kind: SaveFileKind, bytes: Uint8Array,
): void {
  expect(calls).toEqual([{ fileName, kind, bytes, hasControl: true,
    signalAborted: false, isCurrent: true }]);
}

describe('STL/3MF 出力前の 6 項目', () => {
  it('遠い位置にある局所メッシュの原点を落とさず全体110mmと選択10mmを表示する', () => {
    const targets = [1e9, 1e9 + 100].map((originX, index) => {
      const body = bodyFor(`box-${index}`);
      return { ...body, mesh: { ...body.mesh,
        positions: new Float32Array([0, 0, 0, 10, 10, 10, 0, 10, 0]) },
      coordinateFrame: { space: 'local' as const, origin: [originX, 0, 0] as const,
        maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 512 * 1024 * 1024 } };
    });
    const markup = renderToStaticMarkup(createElement(ExportPrintPreflight, {
      targetBodies: targets, unit: 'mm', deviationMm: 0.05, checkedReport: null,
    }));
    expect(markup).toContain('110 mm × 10 mm × 10 mm');
    const selected = renderToStaticMarkup(createElement(ExportPrintPreflight, {
      targetBodies: [targets[1]], unit: 'mm', deviationMm: 0.05, checkedReport: null,
    }));
    expect(selected).toContain('10 mm × 10 mm × 10 mm');
  });

  const body = bodyFor('box');
  const target = { ...body, mesh: { ...body.mesh,
    positions: new Float32Array([0, 0, 0, 25.4, 0, 0, 0, 50.8, 76.2]) } };

  it('画面用寸法を表示単位で示し、出力単位と未計算の実枚数を区別する', () => {
    const markup = renderToStaticMarkup(createElement(ExportPrintPreflight, {
      targetBodies: [target], unit: 'inch', deviationMm: 0.05, checkedReport: null,
    }));
    for (const key of ['exchange.preflightDimensions', 'exchange.preflightUnit',
      'exchange.preflightClosed', 'exchange.preflightDeviation',
      'exchange.preflightTriangles', 'exchange.preflightPrintCheck'] as const) {
      expect(markup).toContain(t(key));
    }
    expect(markup.match(/<dt /g)).toHaveLength(6);
    expect(markup).toContain('1.000 in × 2.000 in × 3.000 in');
    expect(markup).toContain(t('exchange.unitMillimeter'));
    expect(markup).toContain('0.05 mm');
    expect(markup).toContain(t('exchange.notCalculated'));
    expect(markup).toContain(t('exchange.printCheckNotCurrent'));
    expect(markup).not.toContain(`>${body.mesh.triangleCount}<`);
  });

  it('同じ対象の元点検が渡ったときだけ閉立体を点検済みと示す', () => {
    const report: PrintabilityReport = {
      triangleCount: 1, thinTriangles: new Uint8Array(1), overhangTriangles: new Uint8Array(1),
      openEdgeTriangles: new Uint8Array(1), cancelled: false,
      summary: { triangleCount: 1, degenerateCount: 0, inspectedTriangleCount: 1,
        thinCount: 0, overhangCount: 0, openEdgeCount: 0, openEdgeTriangleCount: 0,
        watertight: true, minThicknessFoundMm: 25.4, minThicknessMm: 0.8,
        overhangAngleDeg: 45, cellSizeMm: 1.6 },
    };
    const checked = renderToStaticMarkup(createElement(ExportPrintPreflight, {
      targetBodies: [target], unit: 'mm', deviationMm: 0.005, checkedReport: report,
    }));
    expect(checked).toContain(t('exchange.printCheckClosed'));
    expect(checked).toContain('0.005 mm');
    expect(checked).toContain(t('exchange.notCalculated'));
    expect(checked).not.toContain(t('exchange.printCheckNotCurrent'));
  });

  it('読み込んだ三角形の閉じ方を点検なしで断定しない', () => {
    const markup = renderToStaticMarkup(createElement(ExportPrintPreflight, {
      targetBodies: [{ ...target, bodyKind: 'mesh' }], unit: 'mm',
      deviationMm: 0.05, checkedReport: null,
    }));
    expect(markup).toContain(t('exchange.closedUnverified'));
    expect(markup).not.toContain(t('exchange.closedCheckFailed'));
  });
});

describe('選んでいる立体の数え方(FR-427)', () => {
  it('立体そのものを選んでいれば、その id がそのまま出る', () => {
    expect([...selectedBodyFeatureIds(['extrude-1', 'revolve-2'])])
      .toEqual(['extrude-1', 'revolve-2']);
  });

  it('同じ立体の面を何枚選んでも、立体は 1 つに数える', () => {
    expect([...selectedBodyFeatureIds(['extrude-1#face-3', 'extrude-1#face-4'])])
      .toEqual(['extrude-1']);
  });

  it('面と立体そのものが混ざっても重複しない', () => {
    expect([...selectedBodyFeatureIds(['extrude-1', 'extrude-1#edge-2', 'hole-3#face-1'])])
      .toEqual(['extrude-1', 'hole-3']);
  });

  it('何も選んでいなければ空', () => {
    expect([...selectedBodyFeatureIds([])]).toEqual([]);
  });
});

function pendingExportPanel(initialFormat: 'step' | 'stl' = 'step', autoSubmit = true) {
  const before = useAppStore.getState();
  useAppStore.setState({ bodies: [bodyFor('solid-1')], selection: [], fileName: '部品.pcad',
    requestedGeneration: 0, completedGeneration: 0, isComputing: false });
  let reply!: (outcome: ExchangeExportOutcome) => void;
  const pending = new Promise<ExchangeExportOutcome>((resolve) => { reply = resolve; });
  const exportShapes = vi.fn(() => pending);
  const { save, calls: saveCalls } = observedSave();
  const finished = vi.fn();
  const failed = vi.fn();
  const closed = vi.fn();
  const abortAttemptRef: { current: (() => void) | null } = { current: null };
  const deps: ExchangeDeps = {
    gateway: { openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null),
      hasSaveTarget: () => false, saveFileAs: save },
    kernel: { exportShapes, importShape: () => Promise.reject(new Error('unused')) },
    askImportUnit: () => Promise.resolve('mm'),
    droppedTriangleTemplate: '面積が 0 の三角形を {count} 枚除きました。',
    messageOf: (key) => key,
  };
  const harness = panelHarness();
  const props = { deps, onClose: closed, onFinished: finished, onFailed: failed, abortAttemptRef };
  let root = harness.render(props);
  if (initialFormat === 'stl') {
    const stl = elementWith(root, (element) => element.type === 'button'
      && (element.props as { children?: unknown }).children === 'STL');
    (stl.props as { onClick: () => void }).onClick();
    root = harness.render(props);
  }
  const form = elementWith(root, (element) => element.type === 'form');
  const submit = (form.props as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit;
  if (autoSubmit) submit({ preventDefault: () => {} });
  return { before, harness, props, root, reply, exportShapes, save, saveCalls,
    finished, failed, closed, abortAttemptRef,
    restore: () => { harness.unmount(); useAppStore.setState(before, true); } };
}

async function flushExportReply(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const STEP_FILE: ExchangeExportOutcome = {
  files: [{ fileName: '部品.step', bytes: Uint8Array.of(1, 2) }], droppedTriangleCount: 0,
};

describe('書き出しパネルの実handlerとeffect寿命', () => {
  it('既定STEPを再選択しても再renderなしのsubmitから現ファイルを保存する', async () => {
    const panel = pendingExportPanel('step', false);
    try {
      const step = elementWith(panel.root, element => element.type === 'button'
        && (element.props as { children?: unknown }).children === 'STEP');
      (step.props as { onClick: () => void }).onClick();
      const form = elementWith(panel.root, element => element.type === 'form');
      (form.props as { onSubmit: (event: { preventDefault: () => void }) => void })
        .onSubmit({ preventDefault: () => {} });
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      panel.reply(STEP_FILE);
      await flushExportReply();
      expectCurrentSave(panel.saveCalls, '部品.step', 'step', Uint8Array.of(1, 2));
      expect(panel.finished).toHaveBeenCalledTimes(1);
      expect(panel.closed).toHaveBeenCalledTimes(1);
      expect(panel.failed).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('計算中のSTEPを同値再選択しても保存権限を取り消さない', async () => {
    const panel = pendingExportPanel();
    try {
      const step = elementWith(panel.root, element => element.type === 'button'
        && (element.props as { children?: unknown }).children === 'STEP');
      (step.props as { onClick: () => void }).onClick();
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expectCurrentSave(panel.saveCalls, '部品.step', 'step', Uint8Array.of(1, 2));
      expect(panel.finished).toHaveBeenCalledTimes(1);
      expect(panel.failed).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('同じSTL品質の選択は進行中previewを継続して同じ現bytesを保存する', async () => {
    const panel = pendingExportPanel('stl', false);
    try {
      const standard = elementWith(panel.root, element => element.type === 'button'
        && (element.props as { children?: unknown }).children === t('exchange.qualityStandard'));
      (standard.props as { onClick: () => void }).onClick();
      panel.reply({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(7) }],
        droppedTriangleCount: 0, triangleCount: 7 });
      await flushExportReply();
      const root = panel.harness.render(panel.props);
      const form = elementWith(root, element => element.type === 'form');
      (form.props as { onSubmit: (event: { preventDefault: () => void }) => void })
        .onSubmit({ preventDefault: () => {} });
      await flushExportReply();
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expectCurrentSave(panel.saveCalls, '部品.stl', 'stl', Uint8Array.of(7));
      expect(panel.finished).toHaveBeenCalledTimes(1);
    } finally { panel.restore(); }
  });

  it('StrictModeのeffect cleanup→setupでもpreviewを再開し閉鎖状態を残さない', () => {
    const panel = pendingExportPanel('stl', false);
    try {
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      panel.harness.strictReplay();
      expect(panel.exportShapes).toHaveBeenCalledTimes(2);
      expect(panel.save).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('同じ品質へ戻しても古いrenderのsubmitは失効したtokenを再利用しない', async () => {
    const panel = pendingExportPanel('stl', false);
    try {
      const oldForm = elementWith(panel.root, (element) => element.type === 'form');
      const choose = (label: string): void => {
        const button = elementWith(panel.root, (element) => element.type === 'button'
          && (element.props as { children?: unknown }).children === label);
        (button.props as { onClick: () => void }).onClick();
      };
      choose(t('exchange.qualityCoarse'));
      choose(t('exchange.qualityStandard'));
      (oldForm.props as { onSubmit: (event: { preventDefault: () => void }) => void })
        .onSubmit({ preventDefault: () => {} });
      panel.reply({ files: [{ fileName: 'old.stl', bytes: Uint8Array.of(99) }],
        droppedTriangleCount: 0, triangleCount: 99 });
      await flushExportReply();
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('準備中のclickは同じpreview結果を待ち、kernelを二度呼ばない', async () => {
    const panel = pendingExportPanel('stl');
    try {
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expect(panel.save).not.toHaveBeenCalled();
      panel.reply({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(7) }],
        droppedTriangleCount: 0, triangleCount: 7 });
      await flushExportReply();
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expect(panel.save).toHaveBeenCalledTimes(1);
      expectCurrentSave(panel.saveCalls, '部品.stl', 'stl', Uint8Array.of(7));
    } finally { panel.restore(); }
  });

  it('previewを待つsubmitも同ID別文書への変更後は保存しない', async () => {
    const panel = pendingExportPanel('stl');
    try {
      const current = useAppStore.getState();
      useAppStore.setState({ document: { ...current.document } });
      panel.reply({ files: [{ fileName: 'old.stl', bytes: Uint8Array.of(99) }],
        droppedTriangleCount: 0, triangleCount: 99 });
      await flushExportReply();
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
      expect(panel.failed).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('preview計算失敗後のclickは古い値を保存せず、同じ失敗を一度だけ返す', async () => {
    const before = useAppStore.getState();
    useAppStore.setState({ bodies: [bodyFor('solid-1')], selection: [], fileName: '部品.pcad',
      requestedGeneration: 0, completedGeneration: 0, isComputing: false });
    const save = vi.fn(() => Promise.resolve(true));
    const exportShapes = vi.fn(() => Promise.reject(new Error('preview failed')));
    const failed = vi.fn();
    const deps: ExchangeDeps = {
      gateway: { openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null),
        hasSaveTarget: () => false, saveFileAs: save },
      kernel: { exportShapes, importShape: () => Promise.reject(new Error('unused')) },
      askImportUnit: () => Promise.resolve('mm'), droppedTriangleTemplate: '{count}', messageOf: (key) => key,
    };
    const harness = panelHarness();
    const props = { deps, onClose: vi.fn(), onFinished: vi.fn(), onFailed: failed };
    try {
      let root = harness.render(props);
      const stl = elementWith(root, (element) => element.type === 'button'
        && (element.props as { children?: unknown }).children === 'STL');
      (stl.props as { onClick: () => void }).onClick();
      root = harness.render(props);
      await flushExportReply();
      root = harness.render(props);
      expect(renderToStaticMarkup(root)).toContain(t('exchange.notCalculated'));
      const form = elementWith(root, (element) => element.type === 'form');
      (form.props as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit({ preventDefault: () => {} });
      await flushExportReply();
      expect(exportShapes).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledExactlyOnceWith('preview failed');
      harness.render(props);
      expect(exportShapes).toHaveBeenCalledTimes(1);
    } finally { harness.unmount(); useAppStore.setState(before, true); }
  });

  it.each([
    ['同ID別文書', (state: AppState) => useAppStore.setState({ document: { ...state.document } })],
    ['Undo', (state: AppState) => useAppStore.setState({ undoStack: { ...state.undoStack } })],
    ['添付', (state: AppState) => useAppStore.setState({ importedShapes: new Map(state.importedShapes) })],
  ] as const)('%sへ変わった準備中の旧計数を表示・保存しない', async (_reason, mutate) => {
    const panel = pendingExportPanel('stl', false);
    try {
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      mutate(useAppStore.getState());
      panel.reply({ files: [{ fileName: 'old.stl', bytes: Uint8Array.of(99) }],
        droppedTriangleCount: 0, triangleCount: 99 });
      await flushExportReply();
      const current = panel.harness.render(panel.props);
      expect(renderToStaticMarkup(current)).not.toContain('>99</dd>');
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('粗/標準/細の切替は旧計数を消し、各品質の実kernel結果を一回ずつ採る', async () => {
    const before = useAppStore.getState();
    useAppStore.setState({ bodies: [bodyFor('solid-1')], selection: [], fileName: '部品.pcad',
      requestedGeneration: 0, completedGeneration: 0, isComputing: false });
    const requests: ExchangeExportRequest[] = [];
    const replies: Array<(outcome: ExchangeExportOutcome) => void> = [];
    const { save, calls: saveCalls } = observedSave();
    const deps: ExchangeDeps = {
      gateway: { openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null),
        hasSaveTarget: () => false, saveFileAs: save },
      kernel: { exportShapes: (request) => { requests.push(request);
        return new Promise<ExchangeExportOutcome>((resolve) => { replies.push(resolve); });
      }, importShape: () => Promise.reject(new Error('unused')) },
      askImportUnit: () => Promise.resolve('mm'), droppedTriangleTemplate: '{count}', messageOf: (key) => key,
    };
    const harness = panelHarness();
    const props = { deps, onClose: vi.fn(), onFinished: vi.fn(), onFailed: vi.fn() };
    try {
      let root = harness.render(props);
      const stl = elementWith(root, (element) => element.type === 'button'
        && (element.props as { children?: unknown }).children === 'STL');
      (stl.props as { onClick: () => void }).onClick();
      root = harness.render(props);
      expect(requests.map((request) => request.meshQuality?.deviationMm)).toEqual([0.1]);
      replies[0]({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(37) }],
        droppedTriangleCount: 0, triangleCount: 37 });
      await flushExportReply();
      root = harness.render(props);
      expect(renderToStaticMarkup(root)).toContain('>37</dd>');
      const choose = (label: string, oldCount: number): void => {
        const button = elementWith(root, (element) => element.type === 'button'
          && (element.props as { children?: unknown }).children === label);
        (button.props as { onClick: () => void }).onClick();
        root = harness.render(props);
        expect(renderToStaticMarkup(root)).not.toContain(`>${oldCount}</dd>`);
      };
      choose(t('exchange.qualityCoarse'), 37);
      expect(requests.map((request) => request.meshQuality?.deviationMm)).toEqual([0.1, 0.5]);
      replies[1]({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(13) }],
        droppedTriangleCount: 0, triangleCount: 13 });
      await flushExportReply();
      root = harness.render(props);
      expect(renderToStaticMarkup(root)).toContain('>13</dd>');
      choose(t('exchange.qualityFine'), 13);
      expect(requests.map((request) => request.meshQuality?.deviationMm)).toEqual([0.1, 0.5, 0.02]);
      replies[2]({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(91) }],
        droppedTriangleCount: 0, triangleCount: 91 });
      await flushExportReply();
      root = harness.render(props);
      expect(renderToStaticMarkup(root)).toContain('>91</dd>');
      choose(t('exchange.qualityStandard'), 91);
      expect(requests.map((request) => request.meshQuality?.deviationMm)).toEqual([0.1, 0.5, 0.02, 0.1]);
      replies[3]({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(41) }],
        droppedTriangleCount: 0, triangleCount: 41 });
      await flushExportReply();
      root = harness.render(props);
      expect(renderToStaticMarkup(root)).toContain('>41</dd>');
      const form = elementWith(root, (element) => element.type === 'form');
      (form.props as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit({ preventDefault: () => {} });
      await flushExportReply();
      expect(requests).toHaveLength(4);
      expect(save).toHaveBeenCalledTimes(1);
      expectCurrentSave(saveCalls, '部品.stl', 'stl', Uint8Array.of(41));
      expect(props.onClose).toHaveBeenCalledTimes(1);
      harness.render(props);
      expect(requests).toHaveLength(4);
    } finally { harness.unmount(); useAppStore.setState(before, true); }
  });

  it('閉じた旧パネルの遅着結果は再開封した新パネルへ復活しない', async () => {
    const old = pendingExportPanel('stl', false);
    const close = elementWith(old.root, (element) => element.type === 'button'
      && (element.props as { title?: string }).title === t('controlGuide.exchange.close'));
    (close.props as { onClick: () => void }).onClick();
    const newer = pendingExportPanel('stl', false);
    try {
      old.reply({ files: [{ fileName: 'old.stl', bytes: Uint8Array.of(99) }],
        droppedTriangleCount: 0, triangleCount: 99 });
      newer.reply({ files: [{ fileName: 'new.stl', bytes: Uint8Array.of(17) }],
        droppedTriangleCount: 0, triangleCount: 17 });
      await flushExportReply();
      old.harness.unmount();
      const current = newer.harness.render(newer.props);
      const markup = renderToStaticMarkup(current);
      expect(markup).toContain('>17</dd>');
      expect(markup).not.toContain('>99</dd>');
      expect(old.closed).toHaveBeenCalledTimes(1);
      expect(old.save).not.toHaveBeenCalled();
      expect(newer.exportShapes).toHaveBeenCalledTimes(1);
    } finally { newer.restore(); old.restore(); }
  });

  it('閉じた旧STEPフォームのsubmitを拒否し、新しいパネルだけ保存する', async () => {
    const old = pendingExportPanel('step', false);
    let newer: ReturnType<typeof pendingExportPanel> | null = null;
    try {
      const oldForm = elementWith(old.root, (element) => element.type === 'form');
      const close = elementWith(old.root, (element) => element.type === 'button'
        && (element.props as { title?: string }).title === t('controlGuide.exchange.close'));
      (close.props as { onClick: () => void }).onClick();
      (oldForm.props as { onSubmit: (event: { preventDefault: () => void }) => void })
        .onSubmit({ preventDefault: () => {} });
      expect(old.exportShapes).not.toHaveBeenCalled();
      expect(old.save).not.toHaveBeenCalled();
      expect(old.finished).not.toHaveBeenCalled();
      expect(old.closed).toHaveBeenCalledTimes(1);

      newer = pendingExportPanel('step', false);
      const newForm = elementWith(newer.root, (element) => element.type === 'form');
      (newForm.props as { onSubmit: (event: { preventDefault: () => void }) => void })
        .onSubmit({ preventDefault: () => {} });
      newer.reply(STEP_FILE);
      await flushExportReply();
      expect(newer.exportShapes).toHaveBeenCalledTimes(1);
      expect(newer.save).toHaveBeenCalledTimes(1);
      expectCurrentSave(newer.saveCalls, '部品.step', 'step', Uint8Array.of(1, 2));
      expect(newer.finished).toHaveBeenCalledTimes(1);
    } finally { newer?.restore(); old.restore(); }
  });

  it('異なる実出力計数でも表示したowned結果を保存まで再計算しない', async () => {
    for (const count of [13, 37, 91]) {
      const panel = pendingExportPanel('stl', false);
      try {
        expect(panel.exportShapes).toHaveBeenCalledTimes(1);
        panel.reply({ files: [{ fileName: '部品.stl', bytes: Uint8Array.of(count) }],
          droppedTriangleCount: 0, triangleCount: count });
        await flushExportReply();
        const current = panel.harness.render(panel.props);
        expect(renderToStaticMarkup(current)).toContain(`>${count}</dd>`);
        const form = elementWith(current, (element) => element.type === 'form');
        (form.props as { onSubmit: (event: { preventDefault: () => void }) => void }).onSubmit({ preventDefault: () => {} });
        await flushExportReply();
        expect(panel.exportShapes).toHaveBeenCalledTimes(1);
        expect(panel.save).toHaveBeenCalledTimes(1);
        expect(panel.finished).toHaveBeenCalledTimes(1);
      } finally { panel.restore(); }
    }
  });

  it('取消ボタンでattemptを失効させ、遅いkernel返信を保存・成功UIへ通さない', async () => {
    const panel = pendingExportPanel();
    try {
      const button = elementWith(panel.root, (element) => element.type === 'button'
        && (element.props as { title?: string }).title === t('controlGuide.exchange.close'));
      (button.props as { onClick: () => void }).onClick();
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
      expect(panel.failed).not.toHaveBeenCalled();
      expect(panel.closed).toHaveBeenCalledTimes(1);
      expect(panel.abortAttemptRef.current).toBeNull();
    } finally { panel.restore(); }
  });

  it.each([
    ['同ID別文書', (state: AppState) => useAppStore.setState({ document: { ...state.document } })],
    ['Undo履歴', (state: AppState) => useAppStore.setState({ undoStack: { ...state.undoStack } })],
    ['要求世代', (state: AppState) => useAppStore.setState({ requestedGeneration: state.requestedGeneration + 1 })],
    ['完了世代', (state: AppState) => useAppStore.setState({ completedGeneration: state.completedGeneration + 1 })],
    ['形状', (state: AppState) => useAppStore.setState({ bodies: [...state.bodies] })],
    ['対象', () => useAppStore.setState({ selection: ['another-body'] })],
    ['名前', (state: AppState) => useAppStore.setState({ fileName: `${state.fileName ?? ''}-new` })],
  ] as const)('%sへの変化を購読effectで失効させ、旧replyから保存しない', async (_reason, mutate) => {
    const panel = pendingExportPanel();
    try {
      mutate(useAppStore.getState());
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
      expect(panel.abortAttemptRef.current).toBeNull();
    } finally { panel.restore(); }
  });

  it('形式の操作は旧attemptを即時失効させる', async () => {
    const panel = pendingExportPanel();
    try {
      const format = elementWith(panel.root, (element) => element.type === 'button'
        && (element.props as { title?: string; 'aria-checked'?: boolean }).title === t('controlGuide.exchange.format')
        && (element.props as { 'aria-checked'?: boolean })['aria-checked'] === false);
      (format.props as { onClick: () => void }).onClick();
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('品質の操作も保留中の試行を失効させる', async () => {
    const panel = pendingExportPanel('stl');
    try {
      const quality = elementWith(panel.root, (element) => element.type === 'button'
        && (element.props as { title?: string; 'aria-checked'?: boolean }).title === t('controlGuide.exchange.quality')
        && (element.props as { 'aria-checked'?: boolean })['aria-checked'] === false);
      (quality.props as { onClick: () => void }).onClick();
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('外側クリックへ渡すabort口は遅い返信からの保存を止める', async () => {
    const panel = pendingExportPanel();
    try {
      expect(panel.abortAttemptRef.current).not.toBeNull();
      panel.abortAttemptRef.current?.();
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.save).not.toHaveBeenCalled();
      expect(panel.finished).not.toHaveBeenCalled();
      expect(panel.abortAttemptRef.current).toBeNull();
    } finally { panel.restore(); }
  });

  it('現行の返信は1回保存し、成功UIと閉じるhandlerへ到達する', async () => {
    const panel = pendingExportPanel();
    try {
      panel.reply(STEP_FILE);
      await flushExportReply();
      expect(panel.save).toHaveBeenCalledTimes(1);
      expectCurrentSave(panel.saveCalls, '部品.step', 'step', STEP_FILE.files[0].bytes);
      expect(panel.finished).toHaveBeenCalledExactlyOnceWith([]);
      expect(panel.failed).not.toHaveBeenCalled();
      expect(panel.closed).toHaveBeenCalledTimes(1);
    } finally { panel.restore(); }
  });

  it('古いパネルのcleanupは新パネルのattemptを消さない', async () => {
    const old = pendingExportPanel();
    const newer = pendingExportPanel();
    try {
      old.harness.unmount();
      old.reply(STEP_FILE);
      await flushExportReply();
      expect(old.save).not.toHaveBeenCalled();
      expect(newer.abortAttemptRef.current).not.toBeNull();
      newer.reply(STEP_FILE);
      await flushExportReply();
      expect(newer.save).toHaveBeenCalledTimes(1);
      expect(newer.finished).toHaveBeenCalledTimes(1);
    } finally { newer.restore(); old.restore(); }
  });
});

describe('refused shell export retains current diagnostic targets', () => {
  function shellPanel() {
    const panel = pendingExportPanel('step', false);
    const shell = { ...bodyFor('open-shell'), bodyKind: 'shell' as const };
    const report: PrintabilityReport = {
      triangleCount: 1, thinTriangles: new Uint8Array(1), overhangTriangles: new Uint8Array(1),
      openEdgeTriangles: Uint8Array.of(1), cancelled: false,
      summary: { triangleCount: 1, degenerateCount: 0, inspectedTriangleCount: 1,
        thinCount: 0, overhangCount: 0, openEdgeCount: 3, openEdgeTriangleCount: 1,
        watertight: false, minThicknessFoundMm: 0, minThicknessMm: 0.8,
        overhangAngleDeg: 45, cellSizeMm: 1.6 },
    };
    expect(rememberPrintabilityDisplayMeshes(report, [shell])).toBe(true);
    const state = useAppStore.getState();
    useAppStore.setState({ bodies: [shell], selection: [], printability: report,
      printabilityOwner: { requestToken: {}, document: state.document,
        documentId: state.document.id, documentVersion: state.documentVersion,
        generation: 0, targets: [{ featureId: shell.featureId, mesh: shell.mesh }] },
      printCheckErrorMessage: null, printCheckRequest: null, isInspectingPrint: false });
    const render = (): ReactElement => panel.harness.render(panel.props);
    const choose = (label: string): void => {
      const button = elementWith(render(), element => element.type === 'button'
        && (element.props as { children?: unknown }).children === label);
      (button.props as { onClick: () => void }).onClick();
    };
    choose('STL');
    const preflight = (): ReactElement => elementWith(render(), element => element.type === ExportPrintPreflight);
    return { ...panel, shell, report, render, choose, preflight };
  }

  it('shows original open inspection while refusing preview and submission', () => {
    const panel = shellPanel();
    try {
      const preflight = panel.preflight();
      expect(preflight.props).toMatchObject({ targetBodies: [panel.shell], checkedReport: panel.report,
        triangleCount: null, calculating: false });
      const markup = renderToStaticMarkup(preflight);
      expect(markup.split(t('exchange.closedCheckFailed'))).toHaveLength(3);
      expect(markup).not.toContain(t('exchange.printCheckNotCurrent'));
      const root = panel.render();
      const alert = elementWith(root, element => (element.props as { role?: string }).role === 'alert');
      expect(alert.props).toMatchObject({ children: t('exchangeError.shellNotSupported') });
      const submit = elementWith(root, element => element.type === 'button'
        && (element.props as { type?: string }).type === 'submit');
      expect(submit.props).toMatchObject({ disabled: true });
      const form = elementWith(root, element => element.type === 'form');
      (form.props as { onSubmit: (event: { preventDefault: () => void }) => void })
        .onSubmit({ preventDefault: () => {} });
      expect(panel.exportShapes).not.toHaveBeenCalled();
      expect(panel.save).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it.each(['uninspected', 'inspecting', 'failed', 'document', 'generation', 'mesh', 'owner'] as const)(
    'retains the shell but rejects a %s inspection', reason => {
      const panel = shellPanel();
      try {
        const state = useAppStore.getState();
        switch (reason) {
          case 'uninspected': useAppStore.setState({ printability: null, printabilityOwner: null }); break;
          case 'inspecting': useAppStore.setState({ isInspectingPrint: true }); break;
          case 'failed': useAppStore.setState({ printCheckErrorMessage: 'inspection failed' }); break;
          case 'document': useAppStore.setState({ documentVersion: state.documentVersion + 1 }); break;
          case 'generation': useAppStore.setState({ requestedGeneration: 1 }); break;
          case 'mesh': useAppStore.setState({ bodies: [{ ...panel.shell, mesh: { ...panel.shell.mesh } }] }); break;
          case 'owner':
            if (state.printabilityOwner === null) throw new Error('Missing test inspection owner');
            useAppStore.setState({ printabilityOwner: { ...state.printabilityOwner, targets: [] } }); break;
        }
        const preflight = panel.preflight();
        expect(preflight.props).toMatchObject({ checkedReport: null });
        const markup = renderToStaticMarkup(preflight);
        expect(markup).toContain(t('exchange.closedUnverified'));
        expect(markup).toContain(t('exchange.printCheckNotCurrent'));
        expect(markup).not.toContain(t('exchange.closedCheckFailed'));
        expect(panel.exportShapes).not.toHaveBeenCalled();
      } finally { panel.restore(); }
    },
  );

  it('matches selected shell identity and keeps an empty or different selection uninspected', () => {
    const panel = shellPanel();
    try {
      const other = { ...bodyFor('other-shell'), bodyKind: 'shell' as const };
      useAppStore.setState({ bodies: [panel.shell, other], selection: ['open-shell#face-1'] });
      panel.choose(t('exchange.targetSelected'));
      expect(panel.preflight().props).toMatchObject({ targetBodies: [panel.shell], checkedReport: panel.report });
      useAppStore.setState({ selection: ['other-shell'] });
      expect(panel.preflight().props).toMatchObject({ targetBodies: [other], checkedReport: null });
      useAppStore.setState({ selection: [] });
      expect(panel.preflight().props).toMatchObject({ targetBodies: [], checkedReport: null });
      expect(renderToStaticMarkup(panel.preflight())).toContain(t('exchange.notCalculated'));
      expect(panel.exportShapes).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('keeps the successful mixed export subset and rejects its unrelated shell inspection', () => {
    const panel = shellPanel();
    try {
      const solid = bodyFor('solid');
      useAppStore.setState({ bodies: [panel.shell, solid] });
      expect(panel.preflight().props).toMatchObject({ targetBodies: [solid], checkedReport: null });
      expect(panel.exportShapes).toHaveBeenCalledTimes(1);
      expect(panel.save).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });

  it('does not manufacture dimensions from nonfinite shell positions', () => {
    const panel = shellPanel();
    try {
      useAppStore.setState({ bodies: [{ ...panel.shell, mesh: { ...panel.shell.mesh,
        positions: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]) } }] });
      const preflight = panel.preflight();
      expect(preflight.props).toMatchObject({ checkedReport: null, triangleCount: null });
      expect(renderToStaticMarkup(preflight)).toContain(t('exchange.notCalculated'));
      expect(panel.exportShapes).not.toHaveBeenCalled();
    } finally { panel.restore(); }
  });
});
