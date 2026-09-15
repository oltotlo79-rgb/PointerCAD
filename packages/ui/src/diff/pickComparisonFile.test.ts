import { describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument } from '@pointercad/model';
import { writePcadFile } from '@pointercad/io';
import type { FileGateway, PickedTypedFile } from '../file/fileGateway.js';
import { pickComparisonFile, type DefinitionDiffExecutor } from './pickComparisonFile.js';
import { executeDefinitionDiffWork } from './definitionDiffWork.js';

function gateway(picked: PickedTypedFile | null) {
  const save = vi.fn(), confirm = vi.fn(), clear = vi.fn(), openPcad = vi.fn();
  const openFile = vi.fn(() => Promise.resolve(picked));
  const fileGateway: FileGateway = {
    openFile, openPcad: () => { openPcad(); return Promise.resolve(null); },
    savePcad: () => { save(); return Promise.resolve(null); }, hasSaveTarget: () => true,
    confirmSaveTarget: () => { confirm(); return Promise.resolve(); }, clearSaveTarget: clear,
  };
  return { fileGateway, save, confirm, clear, openPcad, openFile };
}
const execute: DefinitionDiffExecutor = async request => ({ ok: true, reply: await executeDefinitionDiffWork(request) });
describe('比較用の選択は保存先を変更せず、失敗・取消では前の入力を保持できる', () => {
  it('実pcadの読込みを通しても、保存・保存先確定・解除の口へ一度も渡さない', async () => {
    const bytes = writePcadFile(createEmptyPartDocument()), before = [...bytes];
    const f = gateway({ kind: 'pcad', fileName: '前の版.pcad', bytes });
    const result = await pickComparisonFile(f.fileGateway, new AbortController().signal, execute);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.file).toMatchObject({ fileName: '前の版.pcad', documentName: '部品1' });
    expect([...bytes]).toEqual(before); expect(f.fileGateway.hasSaveTarget()).toBe(true);
    for (const forbidden of [f.save, f.confirm, f.clear, f.openPcad]) expect(forbidden).not.toHaveBeenCalled();
    expect(f.openFile).toHaveBeenCalledWith(['pcad']);
  });
  it('壊れたZIPと別形式を成功とせず、既存候補の置換を要求しない', async () => {
    const broken = gateway({ kind: 'pcad', fileName: 'broken.pcad', bytes: new Uint8Array([1, 2, 3]) });
    const result = await pickComparisonFile(broken.fileGateway, new AbortController().signal, execute);
    expect(result.status).toBe('failed'); expect('file' in result).toBe(false);
    const other = gateway({ kind: 'stl', fileName: 'a.stl', bytes: new Uint8Array() });
    const called = vi.fn(execute);
    expect((await pickComparisonFile(other.fileGateway, new AbortController().signal, called)).status).toBe('failed');
    expect(called).not.toHaveBeenCalled();
  });
  it('選択の取消と選択窓が遅れて戻る場合にWorkerも保存も起動しない', async () => {
    const empty = gateway(null), called = vi.fn(execute);
    expect(await pickComparisonFile(empty.fileGateway, new AbortController().signal, called)).toEqual({ status: 'cancelled' });
    const controller = new AbortController(); let selected: ((value: PickedTypedFile) => void) | undefined;
    const delayed: FileGateway = { ...empty.fileGateway, openFile: () => new Promise(resolve => { selected = resolve; }) };
    const pending = pickComparisonFile(delayed, controller.signal, called); controller.abort();
    if (selected === undefined) throw new Error('picker missing');
    selected({ kind: 'pcad', fileName: 'late.pcad', bytes: new Uint8Array() });
    expect(await pending).toEqual({ status: 'cancelled' }); expect(called).not.toHaveBeenCalled();
  });
});
