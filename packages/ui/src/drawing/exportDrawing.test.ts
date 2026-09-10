import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutlinedText } from '@pointercad/drawing';
import { createDrawingDocument } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { createInitialDocumentState } from '../store/initialDocumentState.js';
import type { FileGateway } from '../file/fileGateway.js';
import { drawingFont } from './drawingFont.js';
import { rasterDrawing } from './rasterDrawing.js';
import { exportDrawing } from './exportDrawing.js';

vi.mock('./drawingFont.js', () => ({ drawingFont: { load: vi.fn(), outline: vi.fn() } }));
vi.mock('./rasterDrawing.js', () => ({ rasterDrawing: vi.fn() }));
const state = () => useAppStore.getState();
function outline(text: string, sizeMm: number): OutlinedText {
  return { status: 'ready', missingCharacters: [], fillRule: 'nonzero', metrics: { fontId: 'fixture', sizeMm, advanceMm: sizeMm * text.length,
    inkBounds: { left: 0, right: sizeMm * text.length, bottom: 0, top: sizeMm } },
    subpaths: [{ commands: [{ kind: 'M', to: [0, 0] }, { kind: 'L', to: [1, 1] }, { kind: 'L', to: [2, 0] }, { kind: 'Z' }] }] };
}
function setup() {
  const saveFileAs = vi.fn<NonNullable<FileGateway['saveFileAs']>>(() => Promise.resolve(true));
  const savePcad = vi.fn<FileGateway['savePcad']>(() => Promise.resolve('part.pcad'));
  const gateway: FileGateway = { openPcad: () => Promise.resolve(null), savePcad, hasSaveTarget: () => true, saveFileAs };
  state().setFileGateway(gateway);
  const drawing = createDrawingDocument('加工図', { sourceRef: 'source', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' });
  state().openDrawing(drawing);
  useAppStore.setState({ drawingSourceResolution: { bodyIds: [], center: [0, 0, 0] }, drawingResolution: {
    ok: true, document: drawing, projection: { ok: true, views: [], failures: [], cancelled: false }, dimensions: [], unresolvedCount: 0, sourceChangedExternally: false,
  } });
  return { saveFileAs, savePcad, gateway };
}

describe('図面SVGの保存境界', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState()); vi.mocked(drawingFont.load).mockReset(); vi.mocked(drawingFont.outline).mockReset();
    vi.mocked(drawingFont.load).mockResolvedValue('ready'); vi.mocked(drawingFont.outline).mockImplementation(outline);
  });
  it('mm実寸・日本語の実字体輪郭を種類svgで保存する', async () => {
    const fake = setup(); expect(await exportDrawing({ format: 'svg' })).toBe(true);
    const [name, kind, bytes] = fake.saveFileAs.mock.calls[0];
    expect(name).toBe('加工図.svg'); expect(kind).toBe('svg');
    const svg = new TextDecoder().decode(bytes); expect(svg).toContain('width="420mm"'); expect(svg).not.toContain('<text'); expect(svg).toContain('図名');
    expect(fake.savePcad).not.toHaveBeenCalled(); expect(state().fileGateway.hasSaveTarget()).toBe(true);
  });
  it('ダウンロード取消は成功扱いせず文書の保存状態を変えない', async () => {
    const fake = setup(); fake.saveFileAs.mockResolvedValue(false); const drawing = state().drawing;
    expect(await exportDrawing({ format: 'svg' })).toBe(false); expect(state().drawing).toBe(drawing); expect(state().savedDrawing).toBeNull();
  });
  it('字体の読込み失敗ならファイルを作らず理由を表示する', async () => {
    const fake = setup(); vi.mocked(drawingFont.load).mockResolvedValue('failed');
    expect(await exportDrawing({ format: 'svg' })).toBe(false); expect(fake.saveFileAs).not.toHaveBeenCalled(); expect(state().drawingMessage).not.toBeNull();
  });
  it('必要な字形が欠ける場合にも印刷用の代替文字を作らない', async () => {
    const fake = setup(); vi.mocked(drawingFont.outline).mockImplementation((text, size) => ({ ...outline(text, size), status: 'missingGlyph', metrics: null }));
    expect(await exportDrawing({ format: 'svg' })).toBe(false); expect(fake.saveFileAs).not.toHaveBeenCalled();
  });
  it('非表示・非印刷レイヤーの注記をSVGへ含めない', async () => {
    const fake = setup(), current = state().drawing; if (current === null) throw new Error('図面なし');
    const drawing = { ...current, layers: current.layers.map((layer) => layer.id === 'layer-5' ? { ...layer, printable: false } : layer),
      annotations: [{ id: 'private-note', kind: 'note' as const, text: '検討用', position: [20, 20] as const, height: 3.5, layerId: 'layer-5' }] };
    useAppStore.setState({ drawing }); expect(await exportDrawing({ format: 'svg' })).toBe(true);
    expect(new TextDecoder().decode(fake.saveFileAs.mock.calls[0][2])).not.toContain('検討用');
  });
  it('字体待ちの間に図面を閉じたら古いファイルを出さない', async () => {
    const fake = setup(); let finish: (value: 'ready') => void = () => { throw new Error('未開始'); };
    vi.mocked(drawingFont.load).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = exportDrawing({ format: 'svg' }); state().closeDrawing(); finish('ready');
    expect(await pending).toBe(false); expect(fake.saveFileAs).not.toHaveBeenCalled();
  });
  it('ファイル保存の例外を捕まえて帯へ理由を出す', async () => {
    const fake = setup(); fake.saveFileAs.mockRejectedValue(new Error('保存先へ書けません'));
    expect(await exportDrawing({ format: 'svg' })).toBe(false); expect(state().drawingMessage).toBe('保存先へ書けません');
  });
  it('再計算中の古い投影を保存しない', async () => {
    const fake = setup(); useAppStore.setState({ drawingBusy: true });
    expect(await exportDrawing({ format: 'svg' })).toBe(false); expect(fake.saveFileAs).not.toHaveBeenCalled();
  });
});

describe('PDF・DXF・PNG・JPEGの出力境界(P8-47/48)', () => {
  beforeEach(() => {
    useAppStore.setState(createInitialDocumentState());
    vi.mocked(drawingFont.load).mockReset(); vi.mocked(drawingFont.outline).mockReset(); vi.mocked(rasterDrawing).mockReset();
    vi.mocked(drawingFont.load).mockResolvedValue('ready'); vi.mocked(drawingFont.outline).mockImplementation(outline);
    vi.mocked(rasterDrawing).mockResolvedValue({ ok: true, bytes: new Uint8Array([1, 2, 3]), width: 4961, height: 3508 });
  });
  it('PDFは用紙実寸のPDF1.4と実字体を出し、部品保存先へ書かない', async () => {
    const fake = setup(); expect(await exportDrawing({ format: 'pdf' })).toBe(true);
    const [name, kind, bytes] = fake.saveFileAs.mock.calls[0]; expect(name).toBe('加工図.pdf'); expect(kind).toBe('pdf');
    const body = new TextDecoder().decode(bytes); expect(body.startsWith('%PDF-1.4')).toBe(true); expect(body).toMatch(/\/MediaBox\s*\[0 0 1190\.5512 841\.8898\]/u);
    expect(body).not.toContain('/Subtype /Image'); expect(fake.savePcad).not.toHaveBeenCalled();
  });
  it('DXFはR12の文字実体を保存して制限を表示する', async () => {
    const fake = setup(); state().setFileMessage({ key: 'file.saved', failed: false }); expect(await exportDrawing({ format: 'dxf' })).toBe(true);
    expect(fake.saveFileAs.mock.calls[0][1]).toBe('dxf');
    expect(new TextDecoder().decode(fake.saveFileAs.mock.calls[0][2])).toContain('AC1009');
    expect(state().drawingMessage).toContain('省略 0件'); expect(state().fileMessage).toBeNull();
  });
  it.each(['png', 'jpg'] as const)('%sは指定600dpiで画像化したバイト列を保存する', async (format) => {
    const fake = setup(); expect(await exportDrawing({ format, dpi: 600 })).toBe(true);
    const [svg, width, height, kind, dpi] = vi.mocked(rasterDrawing).mock.calls[0];
    expect(svg).toContain('width="420mm"'); expect([width, height, kind, dpi]).toEqual([420, 297, format, 600]);
    expect(fake.saveFileAs.mock.calls[0]).toEqual([`加工図.${format}`, format, new Uint8Array([1, 2, 3])]);
  });
  it('画像が上限を超えたら保存せず理由を出す', async () => {
    const fake = setup(); vi.mocked(rasterDrawing).mockResolvedValue({ ok: false, reason: 'tooLarge' });
    expect(await exportDrawing({ format: 'png' })).toBe(false); expect(fake.saveFileAs).not.toHaveBeenCalled(); expect(state().drawingMessage).not.toBeNull();
  });
  it('画像化の途中で図面が替わったら古い画像を保存しない', async () => {
    const fake = setup(); let finish: (value: Awaited<ReturnType<typeof rasterDrawing>>) => void = () => { throw new Error('未開始'); };
    vi.mocked(rasterDrawing).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = exportDrawing({ format: 'png' });
    await vi.waitFor(() => expect(rasterDrawing).toHaveBeenCalled()); state().closeDrawing();
    finish({ ok: true, bytes: new Uint8Array([1]), width: 1, height: 1 });
    expect(await pending).toBe(false); expect(fake.saveFileAs).not.toHaveBeenCalled();
  });
  it('字体待ちの連打は同じ図面の保存を二重に起動しない', async () => {
    const fake = setup(); let finish: (value: 'ready') => void = () => { throw new Error('未開始'); };
    vi.mocked(drawingFont.load).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = exportDrawing({ format: 'pdf' }); expect(await exportDrawing({ format: 'pdf' })).toBe(false);
    finish('ready'); expect(await first).toBe(true); expect(fake.saveFileAs).toHaveBeenCalledOnce();
  });
});
