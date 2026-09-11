import { describe, expect, it, vi } from 'vitest';
import { createAutoSaver, createMemoryAutoSaveStorage, readDocumentBundle, type AutoSaver } from '@pointercad/io';
import { createEmptyPartDocument } from '@pointercad/model';
import { applyScriptCommands } from '../../../model/src/scripting/scriptCommands.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { createFakeRecompute, resetTestStore, resultFor, tick } from '../store/testing/createTestStore.js';
import { loadAutoSavePrompt, restoreAutoSave, startAutoSave } from '../file/attachAutoSave.js';
import { runScript } from './scriptActions.js';

describe('自動作図の成功だけを通常の控えへ保存して復元する', () => {
  it('構成・式・立体を控えから復元し、失敗した次の処理では控えを失わない', async () => {
    resetTestStore(); useAppStore.getState().cancelScript();
    const storage = createMemoryAutoSaveStorage(), pending = new Map<number, () => void>(), savers: AutoSaver[] = [];
    let serial = 0, now = Date.parse('2026-09-11T00:00:00Z');
    const detach = startAutoSave({ storage, sessionId: 'script-recovery', createSaver: options => {
      const saver = createAutoSaver({ ...options, now: () => now,
        setTimeout: callback => { const id = ++serial; pending.set(id, callback); return id; },
        clearTimeout: id => { if (typeof id === 'number') pending.delete(id); } });
      savers.push(saver); return saver;
    } });
    const normal = createFakeRecompute(), detachKernel = attachPartRecompute(normal.recompute);
    const fire = (): void => {
      now += 300000;
      const next = pending.entries().next().value; if (next === undefined) throw new Error('no autosave timer');
      pending.delete(next[0]); next[1]();
    };
    try {
      const initial = useAppStore.getState().document;
      const generated = applyScriptCommands(initial, [
        { kind: 'parameter.set', resultId: null, fields: { name: '厚み', source: '1/7', unit: 'mm' }, callStack: 'at (user-script.js:1:1)' },
        { kind: 'solid.box', resultId: 'run:1', fields: { origin: ['0','0','0'], axis: 'z', x: '20', y: '30', z: '厚み' }, callStack: 'at (user-script.js:1:1)' },
      ], new Map(), 'run', 'mm', new Map([['user-script.js', 'create'] ]));
      if (!generated.ok) throw new Error(generated.error.message);
      useAppStore.setState({ scriptPanelOpen: true, scriptLibraryState: 'ready', scriptPhase: 'idle', scriptRequestId: null,
        scriptDraft: { scriptId: 'recovery', name: '控え', icon: 'box', source: 'create', modules: [], seed: '1', time: '2026-09-11T00:00:00Z' },
        scriptExecutor: () => Promise.resolve({ ok: true, prepared: { base: initial, document: generated.document, result: resultFor(generated.document), release: () => Promise.resolve() },
          console: [], commandCount: 2, initializationMs: 1, javascriptMs: 1, cadMs: 1 }) });
      await runScript();
      const call = normal.calls.at(-1); if (call === undefined) throw new Error('no normal recompute');
      call.settle(resultFor(call.document)); await tick();
      fire(); await vi.waitFor(async () => expect(await storage.listRecords()).toHaveLength(1));
      const record = (await storage.listRecords())[0];
      const opened = await readDocumentBundle(record.bytes, 'part');
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.bundle.document).toEqual(generated.document);
      useAppStore.setState({ scriptExecutor: () => Promise.resolve({ ok: false, error: { kind: 'memory', message: '上限', location: null }, console: [] }) });
      await runScript(); fire(); await tick();
      expect(await storage.listRecords()).toEqual([record]);
      detach(); detachKernel();
      useAppStore.getState().resetDocument(createEmptyPartDocument());
      await loadAutoSavePrompt(savers[0], { record }); await restoreAutoSave(savers[0]);
      expect(useAppStore.getState().document).toEqual(generated.document);
      expect(await storage.listRecords()).toEqual([record]);
    } finally { detach(); detachKernel(); useAppStore.getState().cancelScript(); }
  });
});
