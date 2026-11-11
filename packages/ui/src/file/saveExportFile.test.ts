import { describe, expect, it, vi } from 'vitest';
import type { FileGateway } from './fileGateway.js';
import { saveExportFile } from './saveExportFile.js';
const bytes = Uint8Array.of(1, 2, 3);
function gateway(): FileGateway {
  return { openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null), hasSaveTarget: () => false,
    saveFileAs: () => Promise.resolve(true) };
}
describe('保存成功と加工先案内を1回の保存結果に結びつける', () => {
  it('Webのダウンロード保存にも対応し、既定アプリ用の札は作らない', async () => {
    expect(await saveExportFile(gateway(), 'part.stl', 'stl', bytes)).toEqual({ saved: true, handoff: { format: 'stl', token: null } });
  });
  it('Desktopは成功した保存1回の札を使い、同じ内容を二重に保存しない', async () => {
    const saveFileAs = vi.fn(() => Promise.resolve(true)), saveExport = vi.fn(() => Promise.resolve({ token: 'opaque' }));
    const result = await saveExportFile({ ...gateway(), saveFileAs, saveExport }, 'part.step', 'step', bytes);
    expect(result).toEqual({ saved: true, handoff: { format: 'step', token: 'opaque' } });
    expect(saveExport).toHaveBeenCalledExactlyOnceWith('part.step', 'step', bytes);
    expect(saveFileAs).not.toHaveBeenCalled();
  });
  it('Desktopの取消には案内を返さない', async () => {
    expect(await saveExportFile({ ...gateway(), saveExport: () => Promise.resolve(null) }, 'part.3mf', '3mf', bytes)).toEqual({ saved: false });
  });
  it('Webの取消には案内を返さない', async () => {
    expect(await saveExportFile({ ...gateway(), saveFileAs: () => Promise.resolve(false) }, 'part.stl', 'stl', bytes)).toEqual({ saved: false });
  });
  it('保存例外を成功へ変えない', async () => {
    await expect(saveExportFile({ ...gateway(), saveExport: () => Promise.reject(new Error('disk')) }, 'part.step', 'step', bytes)).rejects.toThrow('disk');
  });
  it('加工先の対象外の形式は、従来の保存を使う', async () => {
    const saveExport = vi.fn(() => Promise.resolve({ token: 'unused' }));
    expect(await saveExportFile({ ...gateway(), saveExport }, 'part.obj', 'obj', bytes)).toEqual({ saved: true });
    expect(saveExport).not.toHaveBeenCalled();
  });
  it('失効済の試行はDesktop/Webどちらの保存口も開かない', async () => {
    const saveFileAs = vi.fn(() => Promise.resolve(true));
    const saveExport = vi.fn(() => Promise.resolve({ token: 'unused' }));
    const owner = { ...gateway(), saveFileAs, saveExport };
    const controller = new AbortController();
    controller.abort();
    const control = { signal: controller.signal, isCurrent: () => true };
    expect(await saveExportFile(owner, 'part.step', 'step', bytes, control)).toEqual({ saved: false });
    expect(await saveExportFile(owner, 'part.obj', 'obj', bytes, control)).toEqual({ saved: false });
    expect(saveExport).not.toHaveBeenCalled();
    expect(saveFileAs).not.toHaveBeenCalled();
  });
  it('現行性判定が失われた試行も保存口を開かない', async () => {
    const saveFileAs = vi.fn(() => Promise.resolve(true));
    expect(await saveExportFile({ ...gateway(), saveFileAs }, 'part.obj', 'obj', bytes,
      { signal: new AbortController().signal, isCurrent: () => false })).toEqual({ saved: false });
    expect(saveFileAs).not.toHaveBeenCalled();
  });
});
