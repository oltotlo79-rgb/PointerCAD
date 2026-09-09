import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import type { FileGateway } from '../file/fileGateway.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { prepareDrawingOutput } from './exportDrawing.js';
import { drawingPrintCss, drawingPrintOptions, printDrawing } from './printDrawing.js';

vi.mock('./exportDrawing.js', () => ({ prepareDrawingOutput: vi.fn() }));
const state = () => useAppStore.getState();
function setup() {
  const print = vi.fn<NonNullable<FileGateway['print']>>(() => Promise.resolve(true));
  state().setFileGateway({ openPcad: () => Promise.resolve(null), savePcad: () => Promise.resolve(null), hasSaveTarget: () => false, print });
  const drawing = createDrawingDocument('印刷用', { sourceRef: 'p', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: '', importedAt: '' });
  state().openDrawing(drawing);
  vi.mocked(prepareDrawingOutput).mockResolvedValue({ drawing, render: { widthMm: 420, heightMm: 297, primitives: [] }, isCurrent: () => true });
  return { drawing, print };
}
describe('図面の実寸印刷と部数(P8-49)', () => {
  beforeEach(() => { useAppStore.setState(createInitialDocumentState()); vi.mocked(prepareDrawingOutput).mockReset(); });
  it('A3横の紙面寸法・向き・部数を組み立てる', () => {
    expect(drawingPrintOptions('A3-landscape', 12)).toEqual({ kind: 'drawing', mimeType: 'image/svg+xml', pageSize: 'A3',
      landscape: true, copies: 12, widthMm: 420, heightMm: 297 });
  });
  it('A4縦は幅210mmと高さ297mm', () => {
    expect(drawingPrintOptions('A4-portrait')).toMatchObject({ pageSize: 'A4', landscape: false, copies: 1, widthMm: 210, heightMm: 297 });
  });
  it.each([0, -1, 1.5, 1000, Number.NaN])('不正な部数%sを拒否する', (copies) => { expect(drawingPrintOptions('A3-landscape', copies)).toBeNull(); });
  it('存在しない用紙は印刷しない', () => { expect(drawingPrintOptions('unknown')).toBeNull(); });
  it('Webは@pageに用紙と向き、画像にmm実寸を指定する', () => {
    const options = drawingPrintOptions('A3-landscape'); if (options === null) throw new Error('用紙なし');
    const css = drawingPrintCss(options); expect(css).toContain('@page { size: A3 landscape; margin: 0; }');
    expect(css).toContain('width: 420mm'); expect(css).toContain('height: 297mm'); expect(css).toContain('#root { display: none !important; }');
  });
  it('desktopへ輪郭SVG・用紙・向き・部数を渡す', async () => {
    const { print } = setup(); expect(await printDrawing(3)).toBe(true);
    const [bytes, options] = print.mock.calls[0]; expect(new TextDecoder().decode(bytes)).toContain('width="420mm"');
    expect(options).toMatchObject({ pageSize: 'A3', landscape: true, copies: 3, mimeType: 'image/svg+xml' });
  });
  it('図面が無ければ理由を出して終了する', async () => { expect(await printDrawing()).toBe(false); expect(state().drawingMessage).not.toBeNull(); });
  it('出力準備が終わらなければ印刷しない', async () => {
    const { print } = setup(); vi.mocked(prepareDrawingOutput).mockResolvedValue(null);
    expect(await printDrawing()).toBe(false); expect(print).not.toHaveBeenCalled();
  });
  it('古い文書の出力をプリンターへ渡さない', async () => {
    const { print, drawing } = setup(); vi.mocked(prepareDrawingOutput).mockResolvedValue({ drawing,
      render: { widthMm: 420, heightMm: 297, primitives: [] }, isCurrent: () => false });
    expect(await printDrawing()).toBe(false); expect(print).not.toHaveBeenCalled();
  });
  it('印刷取消を成功としない', async () => {
    const { print } = setup(); print.mockResolvedValue(false); expect(await printDrawing()).toBe(false);
  });
  it('印刷失敗の理由を帯へ出し、次の印刷を妨げない', async () => {
    const { print } = setup(); print.mockRejectedValueOnce(new Error('プリンターへ接続できません'));
    expect(await printDrawing()).toBe(false); expect(state().drawingMessage).toBe('プリンターへ接続できません'); expect(await printDrawing()).toBe(true);
  });
});
