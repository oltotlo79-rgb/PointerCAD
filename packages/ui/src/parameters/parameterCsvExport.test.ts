import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserFileGateway } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { exportParameterCsv } from './parameterCsvExport.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetTestStore();
  const state = useAppStore.getState();
  useAppStore.setState({ document: { ...state.document, parameters: [{ name: 'width', unit: 'mm',
    description: 'size', value: { source: '3', value: 3, display: '3' } }] } });
});

function fixture(stage: 'picker' | 'create' | 'write' | 'close') {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const calls: string[] = [];
  const pause = async (name: typeof stage): Promise<void> => {
    calls.push(name);
    if (name === stage) { entered.resolve(); await gate.promise; }
  };
  const writable = { write: async () => pause('write'), close: async () => pause('close'),
    abort: () => { calls.push('abort'); return Promise.resolve(); } };
  const handle = { name: 'parameters.csv', createWritable: async () => { await pause('create'); return writable; } };
  const scope = { showSaveFilePicker: async () => { await pause('picker'); return handle; } };
  useAppStore.setState({ fileGateway: createBrowserFileGateway(scope) });
  const state = useAppStore.getState();
  const attempt = { pending: { current: null as AbortController | null }, document: state.document,
    documentVersion: state.documentVersion, busy: vi.fn(), issues: vi.fn(), status: vi.fn() };
  return { gate, entered, calls, attempt };
}

describe('CSV export panel ownership through the real browser gateway', () => {
  for (const stage of ['picker', 'create', 'write', 'close'] as const) {
    for (const loss of ['document', 'version', 'unmount'] as const) {
      it(`${loss} during ${stage} suppresses old success and further writes`, async () => {
        const f = fixture(stage);
        const saving = exportParameterCsv(f.attempt);
        await f.entered.promise;
        const controller = f.attempt.pending.current;
        expect(controller).not.toBeNull();
        if (loss === 'document') useAppStore.setState({ document: { ...f.attempt.document } });
        else if (loss === 'version') useAppStore.setState({ documentVersion: f.attempt.documentVersion + 1 });
        else {
          // Exactly the panel cleanup order: detach before abort, no state update after unmount.
          f.attempt.pending.current = null;
          controller?.abort();
        }
        expect(controller?.signal.aborted).toBe(true);
        f.gate.resolve();
        await saving;
        expect(f.attempt.status.mock.calls).toEqual([['']]);
        expect(f.attempt.issues.mock.calls).toEqual([[[]]]);
        expect(f.attempt.busy.mock.calls).toEqual(loss === 'unmount' ? [[true]] : [[true], [false]]);
        expect(f.calls).toEqual(stage === 'picker' ? ['picker'] : stage === 'create'
          ? ['picker', 'create', 'abort'] : stage === 'write'
            ? ['picker', 'create', 'write', 'abort'] : ['picker', 'create', 'write', 'close']);
        // A close already in progress cannot be rolled back; only its stale notification is suppressed.
      });
    }
  }

  it('double activation opens one picker; cancel permits retry before the old picker finishes', async () => {
    const f = fixture('picker');
    const old = exportParameterCsv(f.attempt);
    await f.entered.promise;
    await exportParameterCsv(f.attempt);
    expect(f.calls).toEqual(['picker']);
    f.attempt.pending.current?.abort();
    expect(f.attempt.pending.current).toBeNull();
    const retry = exportParameterCsv(f.attempt);
    const retryController = f.attempt.pending.current;
    expect(retryController).not.toBeNull();
    f.gate.resolve();
    await old;
    await retry;
    expect(f.calls).toEqual(['picker', 'picker', 'create', 'write', 'close']);
    expect(f.attempt.status.mock.calls).toEqual([[''], [''], [t('parameter.csv.exported')]]);
    expect(f.attempt.busy.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  for (const stage of ['picker', 'create', 'write', 'close'] as const) {
    it(`preserves current ${stage} errors and allows a fresh successful retry`, async () => {
      const f = fixture(stage);
      const saving = exportParameterCsv(f.attempt);
      await f.entered.promise;
      f.gate.reject(new Error(`failed ${stage}`));
      await saving;
      expect(f.attempt.issues.mock.calls).toEqual([[[]], [[`failed ${stage}`]]]);
      expect(f.attempt.pending.current).toBeNull();
      const fresh = fixture('picker');
      const retry = exportParameterCsv(fresh.attempt);
      await fresh.entered.promise;
      fresh.gate.resolve();
      await retry;
      expect(fresh.attempt.status).toHaveBeenLastCalledWith(t('parameter.csv.exported'));
    });
  }

  it('late errors after document replacement cannot overwrite a new document status', async () => {
    const f = fixture('write');
    const saving = exportParameterCsv(f.attempt);
    await f.entered.promise;
    useAppStore.setState({ document: { ...f.attempt.document } });
    f.gate.reject(new Error('late disk error'));
    await saving;
    expect(f.attempt.issues.mock.calls).toEqual([[[]]]);
    expect(f.attempt.status.mock.calls).toEqual([['']]);
  });
});
