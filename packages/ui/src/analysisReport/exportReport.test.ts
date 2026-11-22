import type { OutlinedText, RenderDocument } from '@pointercad/drawing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drawingFont } from '../drawing/drawingFont.js';
import type { FileGateway } from '../file/fileGateway.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { reportTime, saveReportPdf } from './exportReport.js';

/** J-03c: the export path the beam and the solid reports share (font wait, PDF, save window, refusals, one export at a time). */
vi.mock('../drawing/drawingFont.js', () => ({ drawingFont: { load: vi.fn(), outline: vi.fn() } }));
const state = () => useAppStore.getState();
const PAGE: RenderDocument = { widthMm: 210, heightMm: 297, primitives: [] };
const EXPORTED_AT = new Date(Date.UTC(2026, 10, 22, 1, 30));

function outline(_text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', missingCharacters: [], fillRule: 'nonzero', metrics: { fontId: 'fixture', sizeMm, advanceMm: sizeMm,
    inkBounds: { left: 0, right: sizeMm, bottom: 0, top: sizeMm } }, subpaths: [] };
}
function gateway() {
  const saveFileAs = vi.fn<NonNullable<FileGateway['saveFileAs']>>(() => Promise.resolve(true));
  state().setFileGateway({ openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve('part.pcad'),
    hasSaveTarget: () => true, saveFileAs });
  return saveFileAs;
}
const prepared = { title: '部品 A 報告書', fileName: '部品 A-solid-cad.pdf', exportedAt: EXPORTED_AT, pages: () => [PAGE] };

describe('解析の報告書の書き出しの共通の道', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState()); vi.mocked(drawingFont.load).mockReset(); vi.mocked(drawingFont.outline).mockReset();
    vi.mocked(drawingFont.load).mockResolvedValue('ready'); vi.mocked(drawingFont.outline).mockImplementation(outline);
  });

  it('字体を待ってから 1 頁の PDF を組み、保存の窓へ 1 回だけ渡す', async () => {
    const saveFileAs = gateway(), pages = vi.fn(() => [PAGE]);
    await expect(saveReportPdf({ owner: 'a', prepare: () => ({ ...prepared, pages }), stillCurrent: () => true })).resolves.toBe(true);
    expect(pages).toHaveBeenCalledTimes(1);
    expect(saveFileAs).toHaveBeenCalledTimes(1);
    const [name, kind, bytes] = saveFileAs.mock.calls[0];
    expect([name, kind]).toEqual(['部品 A-solid-cad.pdf', 'pdf']);
    expect(new TextDecoder('latin1').decode(bytes).startsWith('%PDF-1.4\n')).toBe(true);
  });

  it('作れない時・字体が無い時・会話が替わった時は保存しない', async () => {
    const saveFileAs = gateway();
    await expect(saveReportPdf({ owner: 'a', prepare: () => 'analysisReport.unavailable', stillCurrent: () => true })).resolves.toBe(false);
    expect(state().fileMessage).toEqual({ key: 'analysisReport.unavailable', failed: true });
    expect(drawingFont.load).not.toHaveBeenCalled();
    vi.mocked(drawingFont.load).mockResolvedValue('failed');
    await expect(saveReportPdf({ owner: 'a', prepare: () => prepared, stillCurrent: () => true })).resolves.toBe(false);
    expect(state().fileMessage).toEqual({ key: 'analysisReport.fontFailed', failed: true });
    vi.mocked(drawingFont.load).mockResolvedValue('ready');
    useAppStore.setState({ fileMessage: null });
    await expect(saveReportPdf({ owner: 'a', prepare: () => prepared, stillCurrent: () => false })).resolves.toBe(false);
    expect(state().fileMessage).toBeNull();
    expect(saveFileAs).not.toHaveBeenCalled();
  });

  it('同じ会話の書き出しは重ねず、保存の失敗は理由を出す', async () => {
    const saveFileAs = gateway();
    let finish: ((value: 'ready') => void) | undefined;
    vi.mocked(drawingFont.load).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = saveReportPdf({ owner: 'a', prepare: () => prepared, stillCurrent: () => true });
    await expect(saveReportPdf({ owner: 'a', prepare: () => prepared, stillCurrent: () => true })).resolves.toBe(false);
    finish?.('ready');
    await expect(first).resolves.toBe(true);
    expect(saveFileAs).toHaveBeenCalledTimes(1);
    vi.mocked(drawingFont.load).mockResolvedValue('ready');
    saveFileAs.mockRejectedValue(new Error('保存先へ書けません'));
    await expect(saveReportPdf({ owner: 'a', prepare: () => prepared, stillCurrent: () => true })).resolves.toBe(false);
    expect(state().fileMessage).toEqual({ key: 'analysisReport.failed', failed: true });
  });

  it('見出しの日時はその場の時刻の 年-月-日 時:分', () => {
    expect(reportTime(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02 03:04');
  });
});
